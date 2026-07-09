"""
pre_annotate：半自动标注 Python 端入口（薄壳）。

历史上这里直接加载了一个 Keras 训练的 yaw 分类模型（deep_annotation_inference.h5），
在新版本 TF/Keras 下已无法反序列化。现在改为：

  * 把检测能力全部委托给 `algos.detectors` 里的可插拔后端；
  * 默认使用零依赖的 DummyDetector（几何聚类 + L-shape），保证服务永远可用；
  * 用户装好 torch + OpenPCDet 后，改 detector_config.json 里 backend=openpcdet 就能切到
    CenterPoint / PointPillars 等深度模型。

对外保留旧 API：
  * predict_yaw(points)             -> [rx, ry, rz]
  * annotate_file(pcd_path, output) -> list[dict]  (SUSTechPOINTS 标注 JSON)
  * predict_frame_boxes(pcd_path)   -> list[dict]  (annotate_file 的别名)
  * get_status()                    -> dict       (调试/暴露给 /ml_status 端点)
"""

from __future__ import annotations

import json
import os
from typing import Optional

import numpy as np

from . import detectors


# ---- 兼容旧代码：这些常量原本就存在 ---------------------------------------
NUM_POINT = 512
RESAMPLE_NUM = 10
model_file = "./algos/models/deep_annotation_inference.h5"  # 旧模型，仅作占位

# 旧代码有些地方通过 rotation_model / _ml_disabled_reason 反向探测状态，这里保留
rotation_model = None
_ml_disabled_reason: Optional[str] = None


# ---- 统一入口 -------------------------------------------------------------
def get_status() -> dict:
    """返回当前检测器后端状态，便于 /ml_status 排查问题。"""
    status = detectors.detector_status()
    status["legacy_model_file"] = model_file
    status["legacy_model_available"] = os.path.isfile(model_file)
    return status


def predict_yaw(points) -> list:
    """给定单个物体的点云 (N,3)，估计其 yaw。返回 [rx, ry, rz]。"""
    det = detectors.get_detector()
    try:
        return det.predict_yaw(points)
    except Exception as e:  # noqa: BLE001
        print(f"[pre_annotate] predict_yaw 失败: {e}，返回 0 兜底")
        return [0.0, 0.0, 0.0]


def predict_frame_boxes(pcd_path: str) -> list[dict]:
    """给定单帧 PCD 文件路径，返回 SUSTechPOINTS 前端可直接使用的候选框列表。"""
    det = detectors.get_detector()
    try:
        dets = det.detect_file(pcd_path)
    except Exception as e:  # noqa: BLE001
        print(f"[pre_annotate] detect_file 失败: {e}")
        return []
    return [d.to_sustech_json() for d in dets]


def annotate_file(input: str, output: Optional[str] = None) -> list[dict]:
    """对单个 pcd 文件做预标注。若指定 output，则同时写 JSON。"""
    boxes = predict_frame_boxes(input)
    if output:
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        with open(output, "w", encoding="utf-8") as f:
            json.dump(boxes, f, ensure_ascii=False, indent=2)
    return boxes


# ---- 触发一次检测器加载 + 简单自检（服务启动时打印状态）--------------------
def _warmup() -> None:
    try:
        det = detectors.get_detector()
        # 用一个 100 点的随机小样本走一次代码路径，捕获早期崩溃
        pts = np.random.uniform(-5, 5, size=(100, 3)).astype(np.float32)
        _ = det.detect_points(pts)
        print(f"[pre_annotate] warmup OK, backend={det.name}, available={det.available}")
    except Exception as e:  # noqa: BLE001
        # 不允许 warmup 让服务启动失败
        global _ml_disabled_reason
        _ml_disabled_reason = f"warmup failed: {e}"
        print(f"[pre_annotate] warmup 失败: {e}")


_warmup()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        print(json.dumps(annotate_file(sys.argv[1]), indent=2))
    else:
        print(json.dumps(get_status(), indent=2))
