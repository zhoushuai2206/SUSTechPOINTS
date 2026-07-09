"""
检测器抽象基类与统一输出格式。

Detection.to_sustech_json() 输出的字典与 SUSTechPOINTS 前端
public/js/auto_annotate.js 期望的注解结构一致：

    {
        "obj_type": str,
        "obj_id":   str,
        "psr": {
            "position": {"x", "y", "z"},
            "scale":    {"x", "y", "z"},
            "rotation": {"x", "y", "z"},
        },
        "score":    float,  # 可选，前端目前忽略
    }
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Iterable


@dataclass
class Detection:
    obj_type: str
    position: tuple[float, float, float]  # x, y, z
    scale: tuple[float, float, float]     # dx, dy, dz
    rotation: tuple[float, float, float]  # rx, ry, rz  (rz 是绕 z 轴 yaw)
    score: float = 1.0
    obj_id: str = ""
    extra: dict = field(default_factory=dict)

    def to_sustech_json(self) -> dict:
        return {
            "obj_type": self.obj_type,
            "obj_id": self.obj_id,
            "psr": {
                "position": {"x": float(self.position[0]),
                             "y": float(self.position[1]),
                             "z": float(self.position[2])},
                "scale":    {"x": float(self.scale[0]),
                             "y": float(self.scale[1]),
                             "z": float(self.scale[2])},
                "rotation": {"x": float(self.rotation[0]),
                             "y": float(self.rotation[1]),
                             "z": float(self.rotation[2])},
            },
            "score": float(self.score),
        }


class BaseDetector:
    """所有检测器后端的父类。子类需要实现 detect_points()。"""

    #: 后端友好名，用于日志/状态展示
    name: str = "base"

    #: 是否成功加载（false 表示当前只能给出占位输出）
    available: bool = False

    def describe(self) -> str:
        """返回一段简要说明，用于状态接口。"""
        return f"{self.name} detector (available={self.available})"

    # ------------------------------------------------------------------
    # 主要接口
    # ------------------------------------------------------------------
    def detect_points(self, points) -> list[Detection]:
        """输入 numpy (N, C) 点云，返回 Detection 列表。子类必须实现。"""
        raise NotImplementedError

    def detect_file(self, pcd_path: str) -> list[Detection]:
        """从 PCD 文件读点云并检测。默认实现走 detect_points()。"""
        from ..pcd_io import read_pcd
        pts, _ = read_pcd(pcd_path)
        return self.detect_points(pts)

    # ------------------------------------------------------------------
    # 便捷方法
    # ------------------------------------------------------------------
    def predict_yaw(self, points) -> list[float]:
        """对单个物体点云预测 yaw。默认走 detect_points，取第一个框的 rz。

        如果检测不到任何框（比如 dummy 后端点数太少），返回 [0,0,0]。
        """
        import numpy as np
        pts = np.asarray(points, dtype=float).reshape(-1, 3)
        # 对单物体，我们让检测器把整块点视为一个候选。默认实现只做兜底。
        dets = self.detect_points(pts)
        if not dets:
            return [0.0, 0.0, 0.0]
        rx, ry, rz = dets[0].rotation
        return [float(rx), float(ry), float(rz)]

    @staticmethod
    def to_json_list(dets: Iterable[Detection]) -> list[dict]:
        return [d.to_sustech_json() for d in dets]
