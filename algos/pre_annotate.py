"""自动标注服务使用的本地 BEVFusion ONNX 入口。"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .onnx_detector import LocalOnnxDetector

_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        _detector = LocalOnnxDetector()
    return _detector


def get_status():
    return _get_detector().status()


def predict_frame_boxes(pcd_path: str) -> list[dict]:
    return _get_detector().detect_file(pcd_path)


def annotate_file(input: str, output: str | None = None) -> list[dict]:
    boxes = predict_frame_boxes(input)
    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        with open(output, "w", encoding="utf-8") as f:
            json.dump(boxes, f, ensure_ascii=False, indent=2)
    return boxes


def predict_yaw(points):
    """保留旧接口；物体局部点云的 yaw 仍由几何方法负责。"""
    import numpy as np
    from .detectors_geometry import estimate_yaw_lshape
    pts = np.asarray(points, dtype=np.float32).reshape(-1, 3)
    return [0.0, 0.0, float(estimate_yaw_lshape(pts[:, :2]))] if len(pts) >= 3 else [0.0, 0.0, 0.0]
