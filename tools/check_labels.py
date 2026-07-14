"""CCRS clip 标注一致性检查。

用法：`python tools/check_labels.py data/multi_frame/<clip_name>`

检查内容：
    - obj_type 不在枚举里
    - obj_id 为空
    - 同一帧 obj_id 重复
    - 同一物体尺寸抖动超 ±5%（Pedestrian 除外）
    - 相邻帧 yaw 变化超 30°
    - 同一 id 类别不一致
"""

import json
import os
import sys

import numpy as np


class LabelChecker:
    # 与前端 public/js/obj_cfg.js 枚举保持一致
    DEF_LABELS = [
        "Car", "Truck", "Bus", "Motorcycle", "Bicycle",
        "Pedestrian", "Cone", "ForkLift",
    ]

    def __init__(self, path):
        self.path = path
        self.messages = []
        self.load_frame_ids()
        self.load_labels()

    def clear_messages(self):
        self.messages = []

    def show_messages(self):
        for m in self.messages:
            print(m["frame_id"], m["obj_id"], m["desc"])

    def push_message(self, frame, obj_id, desc):
        self.messages.append({
            "frame_id": frame,
            "obj_id": obj_id,
            "desc": desc,
        })

    def load_frame_ids(self):
        # CCRS 用 lidar_center
        lidar_dir = os.path.join(self.path, 'lidar_center')
        if not os.path.isdir(lidar_dir):
            self.frame_ids = []
            return
        self.frame_ids = [os.path.splitext(f)[0] for f in os.listdir(lidar_dir)]

    def load_labels(self):
        label_folder = os.path.join(self.path, 'label')
        if not os.path.isdir(label_folder):
            self.labels = {}
            self.obj_ids = {}
            return

        files = sorted(os.listdir(label_folder))
        labels = {}
        obj_ids = {}

        for f in files:
            with open(os.path.join(label_folder, f), 'r') as fp:
                l = json.load(fp)
            frame_id = os.path.splitext(f)[0]
            labels[frame_id] = l
            for o in l:
                obj_id = o['obj_id']
                if frame_id:
                    obj_ids.setdefault(obj_id, []).append([frame_id, o])

        self.labels = labels
        self.obj_ids = obj_ids

    def check_one_label(self, func):
        for f in self.labels:
            for o in self.labels[f]:
                func(f, o)

    def check_one_frame(self, func):
        for f in self.labels:
            func(f, self.labels[f])

    def check_one_obj(self, func):
        for oid in self.obj_ids:
            func(oid, self.obj_ids[oid])

    def check_obj_type(self, frame_id, o):
        if o["obj_type"] not in self.DEF_LABELS:
            self.push_message(frame_id, o["obj_id"],
                              f"object type {o['obj_type']} not recognizable")

    def check_obj_id(self, frame_id, o):
        if not o["obj_id"]:
            self.push_message(frame_id, "", f"object {o['obj_type']} id absent")

    def check_frame_duplicate_id(self, frame_id, objs):
        cnt = {}
        for o in objs:
            cnt[o["obj_id"]] = cnt.get(o["obj_id"], 0) + 1
        for oid, n in cnt.items():
            if n > 1:
                self.push_message(frame_id, oid, "duplicate object id")

    def check_obj_size(self, obj_id, label_list):
        if label_list[0][1]['obj_type'] == 'Pedestrian':
            return

        mean = {}
        for axis in ('x', 'y', 'z'):
            vs = [float(l[1]["psr"]["scale"][axis]) for l in label_list]
            mean[axis] = np.array(vs).mean()

        for frame_id, label in label_list:
            for axis in ('x', 'y', 'z'):
                ratio = label["psr"]["scale"][axis] / mean[axis]
                if ratio < 0.95:
                    self.push_message(frame_id, obj_id,
                                      f"dimension {axis} too small: {label['psr']['scale'][axis]}, mean {mean[axis]}")
                elif ratio > 1.05:
                    self.push_message(frame_id, obj_id,
                                      f"dimension {axis} too large: {label['psr']['scale'][axis]}, mean {mean[axis]}")

    def check_obj_direction(self, obj_id, label_list):
        pi = np.pi
        for i in range(1, len(label_list)):
            frame_id, label = label_list[i]
            _, plabel = label_list[i - 1]
            for axis in ('x', 'y', 'z'):
                rotation_delta = label['psr']['rotation'][axis] - plabel['psr']['rotation'][axis]
                if rotation_delta > pi:
                    rotation_delta = 2 * pi - rotation_delta
                elif rotation_delta < -pi:
                    rotation_delta = 2 * pi + rotation_delta
                if abs(rotation_delta) > 30 / 180 * pi:
                    self.push_message(frame_id, obj_id, f"rotation {axis} delta too large")

    def check_obj_type_consistency(self, obj_id, label_list):
        for i in range(1, len(label_list)):
            frame_id, label = label_list[i]
            _, plabel = label_list[i - 1]
            if label['obj_type'] != plabel['obj_type']:
                self.push_message(frame_id, obj_id,
                                  f"different object types: {label['obj_type']}, previous {plabel['obj_type']}")

    def check(self):
        self.clear_messages()
        self.check_one_label(self.check_obj_type)
        self.check_one_label(self.check_obj_id)
        self.check_one_frame(self.check_frame_duplicate_id)
        self.check_one_obj(self.check_obj_size)
        self.check_one_obj(self.check_obj_direction)
        self.check_one_obj(self.check_obj_type_consistency)


if __name__ == "__main__":
    ck = LabelChecker(sys.argv[1])
    ck.check()
    ck.show_messages()
