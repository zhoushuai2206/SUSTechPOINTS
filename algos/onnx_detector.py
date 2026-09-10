"""本地 BEVFusion ONNX 自动标注器。

模型是 CCRS lidar-only PointPillars/CenterHead 0.2m 导出版本：
- 输入 pillar_features [65000, 20, 5]、pillar_num_points [65000]、pillar_coords [65000, 4]
- ONNX 内含 PFN、Scatter、BEV backbone 和 CenterHead raw heads
- 体素化、CenterPoint decode、旋转 NMS 在 Python 侧完成
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
from pathlib import Path

import numpy as np

from .nms import rotated_nms
from .pcd_io import read_pcd


def _preload_cuda_runtime_libraries():
    """让 conda site-packages 中的 cuDNN/CUDA 库对 ONNX Runtime 可见。

    onnxruntime-gpu 需要 cuDNN 9，但 pip/conda 的 nvidia 包通常不会把
    ``site-packages/nvidia/*/lib`` 放进 LD_LIBRARY_PATH。必须在 import
    onnxruntime 之前以 RTLD_GLOBAL 预加载关键库，否则 ORT 会静默回退 CPU。
    """
    lib_dirs = []
    for item in sys.path:
        base = Path(item) / "nvidia"
        if base.is_dir():
            lib_dirs.extend(p for p in base.glob("*/lib") if p.is_dir())
    if not lib_dirs:
        return

    old_path = os.environ.get("LD_LIBRARY_PATH", "").split(":") if os.environ.get("LD_LIBRARY_PATH") else []
    paths = [str(p) for p in lib_dirs]
    os.environ["LD_LIBRARY_PATH"] = ":".join(dict.fromkeys(paths + old_path))

    # 先加载基础 CUDA/cuBLAS，再加载 cuDNN 组件，减少依赖顺序问题。
    prefixes = ("libcudart", "libcublas", "libcublasLt", "libnvrtc",
                "libcufft", "libcurand", "libcusparse", "libcusolver",
                "libcudnn")
    candidates = []
    for directory in lib_dirs:
        for path in directory.iterdir():
            if path.name.startswith(prefixes) and ".so" in path.name:
                candidates.append(path)
    candidates.sort(key=lambda p: (0 if p.name.startswith("libcudnn.so") else 1, str(p)))
    for path in candidates:
        try:
            ctypes.CDLL(str(path), mode=ctypes.RTLD_GLOBAL)
        except OSError:
            pass


class LocalOnnxDetector:
    name = "bevfusion-local-onnx"

    def __init__(self, model_path=None, score_threshold=0.1):
        root = Path(__file__).resolve().parent
        self.model_path = Path(model_path or os.environ.get(
            "SUSTECH_ONNX_MODEL", root / "models" / "model.onnx"))
        self.meta_path = Path(str(self.model_path) + ".meta.json")
        self.score_threshold = float(os.environ.get(
            "SUSTECH_ONNX_SCORE_THRESHOLD", score_threshold))
        self._session = None
        self._provider = None
        self._lock = threading.Lock()
        self._meta = None

        self.point_cloud_range = np.asarray(
            [-25.6, -25.6, -5.0, 25.6, 25.6, 3.0], dtype=np.float32)
        self.voxel_size = np.asarray([0.2, 0.2, 8.0], dtype=np.float32)
        self.max_points = 20
        self.max_voxels = 65000
        self.out_size_factor = 2
        self.max_num = 500
        self.nms_threshold = 0.2
        self.post_max_size = 83
        self.post_center_range = np.asarray(
            [-30.0, -30.0, -10.0, 30.0, 30.0, 10.0], dtype=np.float32)

    @property
    def available(self):
        return self.model_path.is_file() and self.meta_path.is_file()

    def _load(self):
        if self._session is not None:
            return
        with self._lock:
            if self._session is not None:
                return
            if not self.available:
                raise FileNotFoundError(
                    f"ONNX model or metadata missing: {self.model_path}")
            _preload_cuda_runtime_libraries()
            import onnxruntime as ort
            with self.meta_path.open(encoding="utf-8") as f:
                self._meta = json.load(f)
            options = ort.SessionOptions()
            # 该导出模型在 ORT basic/extended fusion 下会触发
            # MatMulBnFusion 的错误形状推断，关闭 graph fusion 后可正常执行。
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            requested = os.environ.get("SUSTECH_ONNX_PROVIDER", "auto")
            available = set(ort.get_available_providers())
            if requested != "auto":
                providers = [requested] if requested in available else ["CPUExecutionProvider"]
            else:
                providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                             if p in available]
            last_error = None
            for provider in providers or ["CPUExecutionProvider"]:
                try:
                    self._session = ort.InferenceSession(
                        str(self.model_path), options, providers=[provider])
                    self._provider = provider
                    break
                except Exception as exc:
                    last_error = exc
                    self._session = None
            if self._session is None:
                raise RuntimeError(f"cannot create ONNX Runtime session: {last_error}")
            # 记录 ORT 实际使用的 EP（当 CUDA EP 缺库时它会静默回退 CPU）。
            active = self._session.get_providers()
            self._provider = active[0] if active else self._provider
            inputs = {x.name for x in self._session.get_inputs()}
            expected = {"pillar_features", "pillar_num_points", "pillar_coords"}
            if inputs != expected:
                raise RuntimeError(f"unexpected ONNX inputs: {sorted(inputs)}")

    def status(self):
        return {
            "backend": self.name,
            "model": str(self.model_path),
            "model_exists": self.model_path.is_file(),
            "available": self.available,
            "loaded": self._session is not None,
            "provider": self._provider,
            "score_threshold": self.score_threshold,
            "input_shape": [self.max_voxels, self.max_points, 5],
        }

    def _voxelize(self, points):
        points = np.asarray(points, dtype=np.float32)
        if points.ndim != 2 or points.shape[1] < 3:
            raise ValueError(f"points must have shape (N,>=3), got {points.shape}")
        # 与 BEVFusion 评测流水线保持一致：`LoadPointsFromMultiSweeps`
        # （模型 config 里 `sweeps_num=0`）在拼接主 lidar 前会执行
        # `points.tensor[:, 4] = 0`，把第 5 维（时间戳）强制清零。单帧
        # 推理没有额外 sweep，因此这里同样把第 5 列置 0，避免不同调用
        # 者把 ring / 真实 timestamp 送进模型，破坏与训练时的输入分布。
        if points.shape[1] >= 5:
            points = points.copy()
            points[:, 4] = 0.0
        features = np.zeros((self.max_voxels, self.max_points, 5), dtype=np.float32)
        counts = np.zeros((self.max_voxels,), dtype=np.float32)
        coords = np.zeros((self.max_voxels, 4), dtype=np.int64)
        key_to_index = {}
        xyz = points[:, :3]
        valid = np.isfinite(xyz).all(axis=1)
        valid &= (xyz >= self.point_cloud_range[:3]).all(axis=1)
        valid &= (xyz < self.point_cloud_range[3:]).all(axis=1)
        for point in points[valid]:
            ijk = np.floor(
                (point[:3] - self.point_cloud_range[:3]) / self.voxel_size
            ).astype(np.int64)
            # coords 列顺序必须与训练/导出模型一致：
            # mmcv `hard_voxelize` 内核按 (ix, iy, iz) 写入 3 列，BEVFusion
            # 再在最前面 pad batch 索引，因此模型期望
            #     pillar_coords[:, 1:] = (ix, iy, iz)
            # （tools/model_deploy/deploy_utils.py 里那句 "(batch_idx, z, y, x)"
            #  的注释是错的，跟 ONNX 图和 PillarFeatureNet 的实际计算不一致。）
            key = (int(ijk[0]), int(ijk[1]), int(ijk[2]))
            pillar = key_to_index.get(key)
            if pillar is None:
                if len(key_to_index) >= self.max_voxels:
                    continue
                pillar = len(key_to_index)
                key_to_index[key] = pillar
                coords[pillar, 1:] = key
            count = int(counts[pillar])
            if count < self.max_points:
                row = np.zeros(5, dtype=np.float32)
                row[:min(5, point.shape[0])] = point[:5]
                features[pillar, count] = row
                counts[pillar] = count + 1
        # 固定 shape 导出模型的 padding 坐标使用 batch index 1。
        coords[len(key_to_index):, 0] = 1
        return features, counts, coords

    @staticmethod
    def _sigmoid(x):
        x = np.clip(np.asarray(x, dtype=np.float32), -50.0, 50.0)
        return 1.0 / (1.0 + np.exp(-x))

    @staticmethod
    def _gather(feat, rows, cols):
        # feat 为 [C,H,W]，保持与 CenterPoint 的 permute/gather 一致。
        return np.asarray(feat[:, rows, cols].T, dtype=np.float32)


    def _decode(self, outputs):
        output_names = [x.name for x in self._session.get_outputs()]
        raw = {name: value for name, value in zip(output_names, outputs)}
        heat = self._sigmoid(raw["task0_heatmap"][0])
        _, height, width = heat.shape
        flat = heat.reshape(-1)
        k = min(self.max_num, flat.size)
        top = np.argpartition(flat, -k)[-k:]
        top = top[np.argsort(-flat[top], kind="stable")]
        scores = flat[top]
        cells = height * width
        inds = top % cells
        classes = top // cells
        # 与 BEVFusion CenterPointBBoxCoder 的实现保持一致：其代码中
        # xs 使用 ind / width，ys 使用 ind % width。
        rows = inds // width
        cols = inds % width

        reg = self._gather(raw["task0_reg"][0], rows, cols)
        xs = rows.astype(np.float32) + reg[:, 0]
        ys = cols.astype(np.float32) + reg[:, 1]
        rot_raw = self._gather(raw["task0_rot"][0], rows, cols)
        yaw = np.arctan2(rot_raw[:, 0], rot_raw[:, 1])
        height_head = self._gather(raw["task0_height"][0], rows, cols)[:, 0]
        dims = np.exp(np.clip(
            self._gather(raw["task0_dim"][0], rows, cols), -10.0, 10.0))
        vel = self._gather(raw["task0_vel"][0], rows, cols)

        boxes = np.column_stack([
            xs * self.out_size_factor * self.voxel_size[0] + self.point_cloud_range[0],
            ys * self.out_size_factor * self.voxel_size[1] + self.point_cloud_range[1],
            height_head,
            dims[:, 0], dims[:, 1], dims[:, 2], yaw,
            vel[:, 0], vel[:, 1],
        ]).astype(np.float32)
        keep = scores > self.score_threshold
        keep &= (boxes[:, :3] >= self.post_center_range[:3]).all(axis=1)
        keep &= (boxes[:, :3] <= self.post_center_range[3:]).all(axis=1)
        boxes, scores, classes = boxes[keep], scores[keep], classes[keep]
        if not len(boxes):
            return []

        # BEVFusion test_cfg: rotate NMS, nms_thr=0.2, post_max_size=83。
        nms_boxes = boxes[:, [0, 1, 3, 4, 6]]
        selected = rotated_nms(
            nms_boxes, scores, self.nms_threshold,
            pre_max_size=1000, post_max_size=self.post_max_size)
        boxes, scores, classes = boxes[selected], scores[selected], classes[selected]

        annotations = []
        for box, score, label in zip(boxes, scores, classes):
            annotations.append(self._build_annotation(box, score, label))
        return annotations

    @staticmethod
    def _build_annotation(box, score, label):
        """把单个 CenterPoint 解码结果转换为 SUSTechPOINTS 标注 JSON。

        字段严格对齐 ``data/**/label/*.json`` 的人工/存量标注格式：
        只包含 ``obj_id``、``obj_type``、``psr(position/rotation/scale)``
        三个键。``obj_id`` 留空由前端 clip 级 "ID" 按钮统一分配；
        ``score`` 属于模型内部指标，不写入标注结果，避免污染 label
        文件的语义（`tools/check_labels.py` 只识别上述三键）。
        """
        # CenterHead 合并 task 结果时把底面 z 加半高，得到几何中心 z。
        center_z = float(box[2] - box[5] * 0.5)
        return {
            "obj_id": "",
            "obj_type": "Car",
            "psr": {
                "position": {
                    "x": float(box[0]),
                    "y": float(box[1]),
                    "z": center_z,
                },
                "rotation": {
                    "x": 0.0,
                    "y": 0.0,
                    "z": float(box[6]),
                },
                "scale": {
                    "x": float(box[3]),
                    "y": float(box[4]),
                    "z": float(box[5]),
                },
            },
        }

    def detect_points(self, points):
        self._load()
        features, counts, coords = self._voxelize(points)
        feed = {
            "pillar_features": features,
            "pillar_num_points": counts,
            "pillar_coords": coords,
        }
        return self._decode(self._session.run(None, feed))

    def detect_file(self, path):
        # 只读 4 维 xyz+intensity；第 5 维（BEVFusion 训练/评测里的
        # sweep timestamp）在 `_voxelize` 里统一置 0，语义等同于
        # `LoadPointsFromMultiSweeps` 的 `points.tensor[:, 4] = 0`。
        # 不再把 ring 送进模型，避免与训练分布不一致。
        points, _ = read_pcd(
            path, want_fields=("x", "y", "z", "intensity"))
        return self.detect_points(points)


