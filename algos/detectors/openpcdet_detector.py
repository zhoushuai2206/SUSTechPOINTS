"""
OpenPCDet 检测器适配层（可选）。

前提：宿主机装好 OpenPCDet（含 spconv、torch）+ 下载好某个预训练权重
（CenterPoint / PointPillars / PV-RCNN 均可）。

启用方式：在 algos/detector_config.json 里写：

    {
        "backend": "openpcdet",
        "openpcdet": {
            "config_path": "/abs/path/to/xxx.yaml",
            "ckpt_path":   "/abs/path/to/xxx.pth",
            "class_names": ["Car", "Pedestrian", "Cyclist"],
            "score_thresh": 0.3,
            "device": "cuda:0"
        }
    }

失败会自动回退 dummy，不影响服务运行。
"""

from __future__ import annotations

import numpy as np

from .base import BaseDetector, Detection
from . import geometry as G


# 与 SUSTechPOINTS 前端 obj_cfg.js 对齐的默认类别映射（可在 config 里覆盖）。
# obj_cfg.js 精简后只保留：Car / Truck / Bus / Motorcycle / Bicycle / Pedestrian / Cone / ForkLift。
_DEFAULT_CLASS_MAP = {
    "Car":            "Car",
    "Vehicle":        "Car",
    "Truck":          "Truck",
    "Bus":            "Bus",
    "Motorcycle":     "Motorcycle",
    "Bicycle":        "Bicycle",
    "Pedestrian":     "Pedestrian",
    "Person":         "Pedestrian",
    "Cone":           "Cone",
}


class OpenPCDetDetector(BaseDetector):
    name = "openpcdet"

    def __init__(self,
                 config_path: str,
                 ckpt_path: str,
                 class_names: list | None = None,
                 score_thresh: float = 0.3,
                 device: str = "cuda:0",
                 class_map: dict | None = None,
                 num_point_features: int = 4):
        self.config_path = config_path
        self.ckpt_path = ckpt_path
        self.score_thresh = float(score_thresh)
        self.device_str = device
        self.class_map = {**_DEFAULT_CLASS_MAP, **(class_map or {})}
        self.num_point_features = int(num_point_features)
        self.class_names = class_names
        self._model = None
        self._torch = None
        self._np_to_gpu = None

        self._load()

    # ------------------------------------------------------------------
    def describe(self) -> str:
        return (f"OpenPCDetDetector(cfg={self.config_path}, "
                f"ckpt={self.ckpt_path}, device={self.device_str}, "
                f"available={self.available})")

    def _load(self):
        # 延迟导入，避免主服务在没装 torch 时也炸
        try:
            import torch  # type: ignore
            from pcdet.config import cfg, cfg_from_yaml_file  # type: ignore
            # 从子模块直接导入，绕过 pcdet.datasets/__init__.py 里对 Argo2Dataset 的顶层 import
            # （Argo2 会引入 av2 + kornia，把 numpy 拉到 2.x 造成 torch 编译不兼容）。
            from pcdet.datasets.dataset import DatasetTemplate  # type: ignore
            from pcdet.models import build_network, load_data_to_gpu  # type: ignore
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"OpenPCDet / torch 未就绪：{e}. "
                "请先按 doc/pre_annotate_integration.md 中的说明安装。"
            ) from e

        self._torch = torch
        self._load_data_to_gpu = load_data_to_gpu

        # OpenPCDet 的 yaml 里 `_BASE_CONFIG_: cfgs/dataset_configs/*.yaml` 是相对
        # `tools/` 的路径。cfg_from_yaml_file 内部 `open()` 用当前工作目录解析这些相对路径，
        # 所以先临时 chdir 到 OpenPCDet 的 tools/ 目录再加载。
        import os
        _cfg_abs = os.path.abspath(self.config_path)
        # 找 OpenPCDet 根：..tools 是 cfg 所在目录的祖先，往上退到 tools/
        _pcdet_tools = _cfg_abs
        while os.path.basename(_pcdet_tools) != "tools" and _pcdet_tools != "/":
            _pcdet_tools = os.path.dirname(_pcdet_tools)
        if os.path.basename(_pcdet_tools) != "tools":
            _pcdet_tools = os.path.dirname(os.path.dirname(_cfg_abs))
        _prev_cwd = os.getcwd()
        try:
            os.chdir(_pcdet_tools)
            cfg_from_yaml_file(_cfg_abs, cfg)
        finally:
            os.chdir(_prev_cwd)
        if self.class_names is None:
            self.class_names = list(cfg.CLASS_NAMES)

        # 用一个极简 dataset 只为拿到 point_feature_encoder / data_processor
        class _MiniDataset(DatasetTemplate):
            def __init__(self, dataset_cfg, class_names, num_point_features):
                super().__init__(dataset_cfg=dataset_cfg,
                                 class_names=class_names,
                                 training=False,
                                 root_path=None,
                                 logger=None)
                self._num_point_features = num_point_features

        self._dataset = _MiniDataset(cfg.DATA_CONFIG, self.class_names,
                                     self.num_point_features)

        self._model = build_network(model_cfg=cfg.MODEL,
                                    num_class=len(self.class_names),
                                    dataset=self._dataset)
        # load_params_from_file 里会调 logger.info / logger.warning，传 None 会崩。
        # 用 stdlib logging 拿一个静默 logger 顶上。
        import logging
        _quiet_logger = logging.getLogger("openpcdet_load")
        if not _quiet_logger.handlers:
            _quiet_logger.addHandler(logging.NullHandler())
        _quiet_logger.setLevel(logging.WARNING)
        self._model.load_params_from_file(filename=self.ckpt_path,
                                          logger=_quiet_logger,
                                          to_cpu=True)
        self._model.to(self.device_str).eval()
        self.available = True

    # ------------------------------------------------------------------
    def detect_points(self, points) -> list[Detection]:
        if not self.available or self._model is None:
            return []

        torch = self._torch
        pts = np.asarray(points, dtype=np.float32)
        if pts.ndim != 2 or pts.shape[1] < 3:
            return []
        # 若模型要求 4 通道（xyz+intensity）而输入只有 xyz，补 0
        if pts.shape[1] < self.num_point_features:
            pad = np.zeros((pts.shape[0], self.num_point_features - pts.shape[1]),
                           dtype=np.float32)
            pts = np.concatenate([pts, pad], axis=1)
        else:
            pts = pts[:, :self.num_point_features]

        input_dict = {
            'points': pts,
            'frame_id': 0,
        }
        data_dict = self._dataset.prepare_data(data_dict=input_dict)
        data_dict = self._dataset.collate_batch([data_dict])
        self._load_data_to_gpu(data_dict)

        with torch.no_grad():
            pred_dicts, _ = self._model.forward(data_dict)

        pred = pred_dicts[0]
        boxes = pred['pred_boxes'].detach().cpu().numpy()   # (N, 7): x,y,z,l,w,h,yaw
        scores = pred['pred_scores'].detach().cpu().numpy()
        labels = pred['pred_labels'].detach().cpu().numpy().astype(int)

        dets: list[Detection] = []
        for b, s, l in zip(boxes, scores, labels):
            if s < self.score_thresh:
                continue
            raw_cls = self.class_names[l - 1] if 1 <= l <= len(self.class_names) else str(l)
            obj_type = self.class_map.get(raw_cls, raw_cls)
            dets.append(Detection(
                obj_type=obj_type,
                position=(float(b[0]), float(b[1]), float(b[2])),
                scale=(float(b[3]), float(b[4]), float(b[5])),
                rotation=(0.0, 0.0, float(b[6])),
                score=float(s),
                extra={"raw_class": raw_cls, "raw_label": int(l)},
            ))
        return dets

    # OpenPCDet 是场景级检测，不适合直接算单物体 yaw，回退到 L-shape
    def predict_yaw(self, points) -> list[float]:
        pts = np.asarray(points, dtype=np.float32).reshape(-1, 3)
        if pts.shape[0] < 3:
            return [0.0, 0.0, 0.0]
        return [0.0, 0.0, float(G.estimate_yaw_lshape(pts[:, :2]))]
