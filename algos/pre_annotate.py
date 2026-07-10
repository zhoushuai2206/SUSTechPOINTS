"""
pre_annotate：自动标注 Python 端入口（薄壳）。

当前只对接一种后端：OpenPCDet + CenterPoint。启动脚本会自动安装依赖并下载权重。

对外 API：
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


def get_status() -> dict:
    """返回当前检测器后端状态，便于 /ml_status 排查问题。"""
    return detectors.detector_status()


def predict_yaw(points) -> list:
    """给定单个物体的点云 (N,3)，估计其 yaw。返回 [rx, ry, rz]。"""
    try:
        det = detectors.get_detector()
    except Exception as e:  # noqa: BLE001
        print(f"[pre_annotate] 获取检测器失败: {e}")
        return [0.0, 0.0, 0.0]
    try:
        return det.predict_yaw(points)
    except Exception as e:  # noqa: BLE001
        print(f"[pre_annotate] predict_yaw 失败: {e}")
        return [0.0, 0.0, 0.0]


def predict_frame_boxes(pcd_path: str) -> list[dict]:
    """给定单帧 PCD 文件路径，返回 SUSTechPOINTS 前端可直接使用的候选框列表。"""
    det = detectors.get_detector()
    dets = det.detect_file(pcd_path)
    return [d.to_sustech_json() for d in dets]


def annotate_file(input: str, output: Optional[str] = None) -> list[dict]:
    """对单个 pcd 文件做预标注。若指定 output，则同时写 JSON。"""
    boxes = predict_frame_boxes(input)
    if output:
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        with open(output, "w", encoding="utf-8") as f:
            json.dump(boxes, f, ensure_ascii=False, indent=2)
    return boxes


def _warmup() -> None:
    """服务启动时触发一次检测器加载与随机点自检，便于早期发现问题。"""
    try:
        det = detectors.get_detector()
        pts = np.random.uniform(-5, 5, size=(1024, 4)).astype(np.float32)
        # 追加一个 timestamp 通道以匹配 CenterPoint（nuScenes 5 维输入）
        pts = np.concatenate([pts, np.zeros((pts.shape[0], 1), dtype=np.float32)], axis=1)
        _ = det.detect_points(pts)
        print(f"[pre_annotate] warmup OK, backend={det.name}, available={det.available}")
    except Exception as e:  # noqa: BLE001
        print(f"[pre_annotate] warmup 失败: {e}")


_warmup()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        print(json.dumps(annotate_file(sys.argv[1]), indent=2))
    else:
        print(json.dumps(get_status(), indent=2))
