"""自动标注旧接口所需的最小 L-shape yaw 估计。"""

from __future__ import annotations

import math
import numpy as np


def estimate_yaw_lshape(xy, step_deg=2):
    xy = np.asarray(xy, dtype=np.float64)
    if xy.shape[0] < 3:
        return 0.0
    best, area = 0.0, float("inf")
    for deg in range(0, 90, max(1, step_deg)):
        theta = math.radians(deg)
        c, s = math.cos(theta), math.sin(theta)
        u = xy[:, 0] * c + xy[:, 1] * s
        v = -xy[:, 0] * s + xy[:, 1] * c
        current = (u.max() - u.min()) * (v.max() - v.min())
        if current < area:
            area, best = current, theta
    return best
