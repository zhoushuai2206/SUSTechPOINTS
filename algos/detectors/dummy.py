"""
兜底检测器：不依赖任何深度学习框架。

流程：地面剔除 → 距离过滤 → 体素聚类 → L-shape yaw → box 尺寸 → 类别粗猜。

用途：
  1) 深度模型（CenterPoint/PointPillars）尚未部署时，`/auto_annotate` 也能给出
     可用的候选框，不再 500。
  2) `predict_yaw()` 的稳定实现，取代旧的 Keras 3 不兼容模型。
"""

from __future__ import annotations

import numpy as np

from .base import BaseDetector, Detection
from . import geometry as G


class DummyDetector(BaseDetector):
    name = "dummy_cluster"
    available = True

    def __init__(self,
                 max_range: float = 60.0,
                 min_range: float = 1.5,
                 voxel: float = 0.4,
                 min_cluster_pts: int = 30,
                 max_clusters: int = 80,
                 ground_margin: float = 0.25,
                 min_scale: tuple = (0.2, 0.2, 0.2),
                 max_scale: tuple = (20.0, 5.0, 5.0),
                 score: float = 0.3):
        self.max_range = float(max_range)
        self.min_range = float(min_range)
        self.voxel = float(voxel)
        self.min_cluster_pts = int(min_cluster_pts)
        self.max_clusters = int(max_clusters)
        self.ground_margin = float(ground_margin)
        self.min_scale = np.asarray(min_scale, dtype=np.float32)
        self.max_scale = np.asarray(max_scale, dtype=np.float32)
        self.default_score = float(score)

    def describe(self) -> str:
        return ("DummyDetector（几何聚类兜底）：不依赖深度学习。适合快速验证"
                f"标注管线，参数: voxel={self.voxel}, "
                f"min_pts={self.min_cluster_pts}, range=[{self.min_range},{self.max_range}]")

    # ------------------------------------------------------------------
    def detect_points(self, points) -> list[Detection]:
        pts = np.asarray(points, dtype=np.float32)
        if pts.ndim != 2 or pts.shape[1] < 3:
            return []
        pts = pts[:, :3]

        # 1) 距离过滤
        r = np.linalg.norm(pts[:, :2], axis=1)
        pts = pts[(r >= self.min_range) & (r <= self.max_range)]
        if pts.shape[0] < self.min_cluster_pts:
            return []

        # 2) 地面剔除
        pts = G.remove_ground(pts, margin=self.ground_margin)
        if pts.shape[0] < self.min_cluster_pts:
            return []

        # 3) 聚类
        clusters = G.voxel_cluster(pts,
                                   voxel=self.voxel,
                                   min_pts=self.min_cluster_pts,
                                   max_clusters=self.max_clusters)

        dets: list[Detection] = []
        for idx in clusters:
            cluster_pts = pts[idx]
            pos, scale, rot = G.points_to_box(cluster_pts)
            # 尺寸过滤
            if (np.any(scale < self.min_scale) or
                np.any(scale > self.max_scale)):
                continue
            obj_type = G.guess_type_by_scale(scale)
            dets.append(Detection(
                obj_type=obj_type,
                position=tuple(pos.tolist()),
                scale=tuple(scale.tolist()),
                rotation=tuple(rot.tolist()),
                score=self.default_score,
            ))
        return dets

    # 单物体点云的 yaw 估计（覆盖父类默认实现，避免走一遍聚类）
    def predict_yaw(self, points) -> list[float]:
        pts = np.asarray(points, dtype=np.float32).reshape(-1, 3)
        if pts.shape[0] < 3:
            return [0.0, 0.0, 0.0]
        yaw = float(G.estimate_yaw_lshape(pts[:, :2]))
        return [0.0, 0.0, yaw]
