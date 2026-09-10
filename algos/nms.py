"""纯 NumPy 的旋转 BEV NMS，避免自动标注服务依赖 mmdet3d。"""

from __future__ import annotations

import math
import numpy as np


def _corners(box):
    x, y, length, width, yaw = map(float, box)
    c, s = math.cos(yaw), math.sin(yaw)
    local = np.array([[length / 2, width / 2], [-length / 2, width / 2],
                      [-length / 2, -width / 2], [length / 2, -width / 2]], dtype=np.float64)
    rot = np.array([[c, -s], [s, c]], dtype=np.float64)
    return local @ rot.T + np.array([x, y])


def _inside(p, a, b):
    return np.cross(b - a, p - a) >= -1e-9


def _intersection(p1, p2, a, b):
    d1, d2 = p2 - p1, b - a
    den = np.cross(d1, d2)
    if abs(den) < 1e-12:
        return p2.copy()
    t = np.cross(a - p1, d2) / den
    return p1 + t * d1


def _clip(subject, clip):
    output = subject
    for i in range(len(clip)):
        if len(output) == 0:
            break
        a, b = clip[i], clip[(i + 1) % len(clip)]
        input_polygon = output
        output = []
        previous = input_polygon[-1]
        for current in input_polygon:
            cur_in, prev_in = _inside(current, a, b), _inside(previous, a, b)
            if cur_in:
                if not prev_in:
                    output.append(_intersection(previous, current, a, b))
                output.append(current)
            elif prev_in:
                output.append(_intersection(previous, current, a, b))
            previous = current
        output = np.asarray(output, dtype=np.float64).reshape(-1, 2)
    return output


def _area(poly):
    if len(poly) < 3:
        return 0.0
    return abs(float(np.dot(poly[:, 0], np.roll(poly[:, 1], -1)) -
                   np.dot(poly[:, 1], np.roll(poly[:, 0], -1))) * 0.5)


def rotated_iou(a, b):
    pa, pb = _corners(a), _corners(b)
    inter = _area(_clip(pa, pb))
    union = float(a[2] * a[3] + b[2] * b[3] - inter)
    return inter / union if union > 1e-12 else 0.0


def rotated_nms(boxes, scores, iou_threshold=0.2, pre_max_size=1000, post_max_size=83):
    """返回按分数降序排列的保留索引；boxes 为 [x,y,length,width,yaw]。"""
    if len(boxes) == 0:
        return np.empty(0, dtype=np.int64)
    order = np.argsort(-np.asarray(scores, dtype=np.float32), kind="stable")[:pre_max_size]
    keep = []
    while len(order):
        current = int(order[0])
        keep.append(current)
        if len(keep) >= post_max_size or len(order) == 1:
            break
        rest = order[1:]
        order = np.asarray([i for i in rest
                            if rotated_iou(boxes[current], boxes[int(i)]) <= iou_threshold],
                           dtype=np.int64)
    return np.asarray(keep, dtype=np.int64)
