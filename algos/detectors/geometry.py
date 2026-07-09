"""
纯 numpy 的几何工具：地面剔除、欧氏聚类、L-shape 拟合、由点云和 yaw 反求 3D box。

这些函数用于 DummyDetector，以及作为 predict_yaw() 的兜底实现。不要求任何深度学习依赖。
"""

from __future__ import annotations

import math
import numpy as np


# ----------------------------- 地面剔除 -----------------------------
def remove_ground(points: np.ndarray, z_bin: float = 0.15,
                  margin: float = 0.25) -> np.ndarray:
    """基于最低 z 直方图峰值粗略估计地面高度，再抬升 margin 米作为切割阈值。

    输入 points: (N, >=3)。返回同 shape 的子集。
    """
    if points.size == 0:
        return points
    z = points[:, 2]
    zmin, zmax = float(np.min(z)), float(np.max(z))
    if zmax - zmin < 1e-3:
        return points
    bins = max(4, int(math.ceil((zmax - zmin) / z_bin)))
    hist, edges = np.histogram(z, bins=bins)
    peak = edges[int(np.argmax(hist))]
    thresh = peak + margin
    keep = z > thresh
    return points[keep]


# ----------------------------- 体素聚类 -----------------------------
def voxel_cluster(points: np.ndarray, voxel: float = 0.4,
                  min_pts: int = 20, max_clusters: int = 200) -> list[np.ndarray]:
    """基于 3D 体素连通域的极简聚类，避免引入 scipy/sklearn。

    思路：把点映射到 voxel 网格 (ix, iy, iz)，用广度优先扫描 26-邻域找连通体素，
    体素内的原始点索引一起返回。适合稀疏点云 + 粗聚类，够用来做半自动预标注。
    """
    if points.shape[0] == 0:
        return []

    coords = np.floor(points[:, :3] / voxel).astype(np.int64)
    # 把 (ix, iy, iz) hash 到一个 dict[voxel_key] -> list of point indices
    vox: dict[tuple[int, int, int], list[int]] = {}
    for i, c in enumerate(coords):
        key = (int(c[0]), int(c[1]), int(c[2]))
        vox.setdefault(key, []).append(i)

    visited: set[tuple[int, int, int]] = set()
    clusters: list[np.ndarray] = []

    # 26 邻域偏移
    offsets = [(dx, dy, dz)
               for dx in (-1, 0, 1)
               for dy in (-1, 0, 1)
               for dz in (-1, 0, 1)
               if not (dx == 0 and dy == 0 and dz == 0)]

    for start in vox.keys():
        if start in visited:
            continue
        queue = [start]
        visited.add(start)
        member_idx: list[int] = []
        while queue:
            k = queue.pop()
            member_idx.extend(vox[k])
            for off in offsets:
                nk = (k[0] + off[0], k[1] + off[1], k[2] + off[2])
                if nk in vox and nk not in visited:
                    visited.add(nk)
                    queue.append(nk)
        if len(member_idx) >= min_pts:
            clusters.append(np.asarray(member_idx, dtype=np.int64))
        if len(clusters) >= max_clusters:
            break

    # 按点数从多到少排序，前端更关心大目标
    clusters.sort(key=lambda a: -a.shape[0])
    return clusters


# ----------------------------- L-shape yaw -----------------------------
def estimate_yaw_lshape(xy: np.ndarray, step_deg: int = 2) -> float:
    """L-shape fitting：以 xy 平面上覆盖长方形面积最小的角度作为 yaw。

    xy: (N, 2)。返回值范围 [-pi/2, pi/2]（长方形有 180° 二义性，前端可再调整）。
    """
    if xy.shape[0] < 3:
        return 0.0
    best_theta = 0.0
    best_area = float("inf")
    for deg in range(0, 90, max(1, step_deg)):
        theta = math.radians(deg)
        c, s = math.cos(theta), math.sin(theta)
        # 旋转 xy -> uv
        u = xy[:, 0] * c + xy[:, 1] * s
        v = -xy[:, 0] * s + xy[:, 1] * c
        area = (u.max() - u.min()) * (v.max() - v.min())
        if area < best_area:
            best_area = area
            best_theta = theta
    return best_theta


# ----------------------------- 由点云求 3D box -----------------------------
def points_to_box(points: np.ndarray,
                  yaw: float | None = None,
                  ground_margin: float = 0.05) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """给定一个物体的点云，返回 (position, scale, rotation)。

    position: 长方体几何中心 [x, y, z]
    scale:    长/宽/高 [dx, dy, dz]
    rotation: [0, 0, yaw]
    """
    pts = np.asarray(points, dtype=np.float64)
    if yaw is None:
        yaw = estimate_yaw_lshape(pts[:, :2])

    c, s = math.cos(yaw), math.sin(yaw)
    # 把点旋转到"box 局部坐标"，再取 min/max
    local = np.stack([pts[:, 0] * c + pts[:, 1] * s,
                      -pts[:, 0] * s + pts[:, 1] * c,
                      pts[:, 2]], axis=1)
    pmin = local.min(axis=0)
    pmax = local.max(axis=0)

    # 让高度稍稍延伸到地面下 ground_margin，视觉上更贴合
    pmin[2] -= ground_margin

    center_local = (pmin + pmax) / 2.0
    dims = pmax - pmin

    # 局部中心转回全局
    cx = center_local[0] * c - center_local[1] * s
    cy = center_local[0] * s + center_local[1] * c
    cz = center_local[2]

    position = np.array([cx, cy, cz], dtype=np.float64)
    scale = np.asarray(dims, dtype=np.float64)
    rotation = np.array([0.0, 0.0, yaw], dtype=np.float64)
    return position, scale, rotation


# ----------------------------- 类别粗猜 -----------------------------
# 与前端 obj_cfg.js popularCategories 保持一致，避免最后前端再猜一次
_POPULAR = [
    ("Car",           (4.5, 1.8, 1.5)),
    ("Pedestrian",    (0.4, 0.5, 1.7)),
    ("Van",           (4.5, 1.8, 1.5)),
    ("Bus",           (13.0, 3.0, 3.5)),
    ("Truck",         (10.0, 2.8, 3.0)),
    ("Scooter",       (1.6, 0.6, 1.0)),
    ("ScooterRider",  (1.6, 0.6, 1.6)),
    ("Bicycle",       (1.6, 0.6, 1.2)),
    ("BicycleRider",  (1.6, 0.6, 1.7)),
]


def guess_type_by_scale(scale) -> str:
    sx, sy, sz = float(scale[0]), float(scale[1]), float(scale[2])
    if sx <= 0 or sy <= 0 or sz <= 0:
        return "Unknown"
    # 长边优先，减少混淆
    if sx < sy:
        sx, sy = sy, sx
    best = "Unknown"
    best_score = -1.0
    for name, (rx, ry, rz) in _POPULAR:
        # 前端逻辑：min(a,b)/max(a,b) 三轴相加
        def _ratio(a, b):
            return min(a, b) / max(a, b)
        score = _ratio(rx, sx) + _ratio(ry, sy) + _ratio(rz, sz)
        if score > best_score:
            best_score = score
            best = name
    return best
