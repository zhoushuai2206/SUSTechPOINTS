"""CCRS clip 元数据 / 标定 / 标注读取。

CCRS clip 目录布局（`data/<category>/<clip_name>/...`）：

    calib/
        camera/<name>.json      # 相机内外参
        lidar/<name>.json       # 雷达外参（暂未直接读取，但保留在磁盘上）
    camera_<name>/              # 图像帧（jpg/png）
    lidar_center/               # 雷达帧（pcd）
    label/<frame>.json          # 3D 框标注（可为空目录）
    ego_pose/<frame>.json       # 单帧车体位姿（可选）
    desc.json                   # 场景描述（可选）

`<category>` 目前有 `single_frame` 与 `multi_frame` 两种，返回的 scene 名前缀会
带上 category，方便与前端 `data/${scene}/...` URL 组装、以及后端
`os.path.join(root_dir, scene)` 直接可用。
"""

import json
import os

try:
    import numpy as _np
except ImportError:  # numpy 是项目必备依赖，这里做保护性回退
    _np = None

# scene_reader.py 位于 tools/ 目录下，data/ 在项目根目录（parent of tools/）。
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
root_dir = os.path.join(_PROJECT_ROOT, "data")

# CCRS 雷达数据目录固定名字
LIDAR_DIR = "lidar_center"
CAMERA_DIR_PREFIX = "camera_"

# 新版数据目录布局：data/<category>/<clip_name>/... 。category 表示该 clip 是
# 单帧还是连续帧；返回给前端的 scene 名会保留 category 前缀。
CATEGORY_DIR_NAMES = ("single_frame", "multi_frame")


def _is_valid_clip_dir(clip_dir_abs):
    """判定绝对路径是否是合法的 CCRS clip 目录：有 lidar_center 子目录、未被 disable。"""
    if not os.path.isdir(clip_dir_abs):
        return False
    if os.path.exists(os.path.join(clip_dir_abs, "disable")):
        return False
    return os.path.isdir(os.path.join(clip_dir_abs, LIDAR_DIR))


def get_all_scenes():
    all_scenes = get_scene_names()
    print(all_scenes)
    return [get_one_scene(s) for s in all_scenes]


def get_all_scene_desc():
    return {n: get_scene_desc(n) for n in get_scene_names()}


def get_scene_names():
    """扫描 data 目录，返回全部有效 clip 的名称列表（"<category>/<clip_name>"）。"""
    if not os.path.isdir(root_dir):
        return []

    scenes = []
    for category in CATEGORY_DIR_NAMES:
        category_abs = os.path.join(root_dir, category)
        if not os.path.isdir(category_abs):
            continue
        for clip in os.listdir(category_abs):
            clip_abs = os.path.join(category_abs, clip)
            if _is_valid_clip_dir(clip_abs):
                scenes.append(f"{category}/{clip}")

    scenes.sort()
    return scenes


def get_scene_desc(s):
    scene_dir = os.path.join(root_dir, s)
    desc_file = os.path.join(scene_dir, "desc.json")
    if os.path.exists(desc_file):
        with open(desc_file) as f:
            return json.load(f)
    return None


def _camera_name_from_dir(d):
    """从 `camera_<name>` 目录名中提取 name。"""
    if not d.startswith(CAMERA_DIR_PREFIX):
        return None
    name = d[len(CAMERA_DIR_PREFIX):]
    return name or None


def _camera_name_from_calib_file(stem):
    """从 calib/camera 目录下 `camera_<name>.json` 文件名推断相机名。"""
    if stem.startswith(CAMERA_DIR_PREFIX):
        name = stem[len(CAMERA_DIR_PREFIX):]
        if name:
            return name
    return stem


def _invert_transform_16(m):
    """对行优先 4x4 齐次变换（16 元素）矩阵求逆。

    有些标定文件里旋转子矩阵并非严格正交（数值优化后的近似），因此不能简单用
    R^T 来求逆，这里直接用通用 4x4 逆矩阵；numpy 缺失时才回退到刚体近似解。
    """
    if not (isinstance(m, (list, tuple)) and len(m) == 16):
        return m

    if _np is not None:
        try:
            arr = _np.array(m, dtype=float).reshape(4, 4)
            inv = _np.linalg.inv(arr)
            return inv.flatten().tolist()
        except Exception as e:
            print(f"[scene_reader] extrinsic inverse failed, fallback to R^T: {e}")

    # 回退：刚体近似（假设 R 正交）
    r00, r01, r02 = m[0], m[1], m[2]
    r10, r11, r12 = m[4], m[5], m[6]
    r20, r21, r22 = m[8], m[9], m[10]
    t0, t1, t2 = m[3], m[7], m[11]

    rt00, rt01, rt02 = r00, r10, r20
    rt10, rt11, rt12 = r01, r11, r21
    rt20, rt21, rt22 = r02, r12, r22

    it0 = -(rt00 * t0 + rt01 * t1 + rt02 * t2)
    it1 = -(rt10 * t0 + rt11 * t1 + rt12 * t2)
    it2 = -(rt20 * t0 + rt21 * t1 + rt22 * t2)

    return [
        rt00, rt01, rt02, it0,
        rt10, rt11, rt12, it1,
        rt20, rt21, rt22, it2,
        0.0, 0.0, 0.0, 1.0,
    ]


def _extrinsic_needs_invert(frame_id):
    """判定 extrinsic 是否为 <sensor>→ego 方向，需要求逆以变为前端期望的 ego→<sensor>。

    CCRS 标定文件里 frame_id 形如 "camera2ego"、"lidar2ego" 表示原矩阵是 sensor→ego。
    前端 image.js 假设 extrinsic 直接作用于 3D 点得到相机系坐标，因此需要 ego→sensor。
    """
    if not isinstance(frame_id, str):
        return False
    return frame_id.strip().lower().endswith("2ego")


def _detect_camera_axes_in_ego(cam2ego_16):
    """给定 T_ego←cam（16 元素行优先），返回相机 X/Y/Z 轴在 ego 系下的三维向量。"""
    m = cam2ego_16
    ax_x = (m[0], m[4], m[8])
    ax_y = (m[1], m[5], m[9])
    ax_z = (m[2], m[6], m[10])
    return ax_x, ax_y, ax_z


def _need_flip_x_for_opencv_cam(cam2ego_16):
    """检测该相机是否为"左下前"约定，需要对 X 做翻转以变成 OpenCV "右下前"。

    判定：在 ego(FLU：X前, Y左, Z上) 中，标准 OpenCV 前视相机应满足
      - cam_Z 指向 ego +X（前）
      - cam_Y 指向 ego -Z（下）
      - cam_X 指向 ego -Y（右）
    若发现 cam_X 与 ego -Y 反向（即 cam_X · ego_-Y < 0，等价 cam_X · ego_+Y > 0），
    说明相机是"左下前"，需要翻转 X。
    """
    if not (isinstance(cam2ego_16, (list, tuple)) and len(cam2ego_16) == 16):
        return False
    ax_x, _, ax_z = _detect_camera_axes_in_ego(cam2ego_16)
    # 只对"前视/主要沿 ego +X 方向的相机"做自动翻转，避免误触发其他视角。
    if ax_z[0] <= 0:  # 光轴不指向车头方向，不做假设
        return False
    # cam_X 在 ego 中的 Y 分量若为正，说明 cam_X 指向 ego +Y（左），属"左下前"
    return ax_x[1] > 0


def _normalize_camera_calib(raw):
    """把 CCRS 相机标定归一为前端期望的 {intrinsic:[9], extrinsic:[16], ...}。

    CCRS 格式：`{"intrinsic": {"cam_K": [9], "cam_dist": [...]}, "extrinsic": [16], "frame_id": "camera2ego"}`

    `extrinsic` 的语义由 `frame_id` 指定，例如 "camera2ego" 表示该矩阵把相机系
    点变换到 ego 系（T_ego←camera）。3D 标注框已经在 ego 系下，前端 image.js 的
    投影公式期望 extrinsic 是 T_camera←ego（即 ego→camera），因此当 frame_id
    以 "2ego" 结尾时，这里对 extrinsic 求逆再交给前端，保持前端代码语义不变。
    """
    if not isinstance(raw, dict):
        return raw

    out = dict(raw)  # 保留其他字段（image_width/height 等）以备将来使用
    intr = raw.get("intrinsic")
    if isinstance(intr, dict):
        cam_k = intr.get("cam_K")
        if cam_k is not None:
            out["intrinsic"] = cam_k
        # 畸变系数单独暴露，前端目前未使用但保留
        cam_dist = intr.get("cam_dist")
        if cam_dist is not None:
            out["distortion"] = cam_dist

    extr = out.get("extrinsic")
    frame_id = raw.get("frame_id")
    if isinstance(extr, list) and len(extr) == 16 and _extrinsic_needs_invert(frame_id):
        # 原始 extr 是 T_ego←cam（camera2ego）
        cam2ego = extr
        ego2cam = _invert_transform_16(cam2ego)

        # 部分数据源的相机坐标系是"左下前"（cam_X 指向 ego 左方），而前端 image.js 中
        # 的 pinhole 公式 uv = K · [R|t] · P 隐含 OpenCV 约定的"右下前"（cam_X 向右）。
        # 若检测到"左下前"，把 ego2cam 左乘 diag(-1,1,1,1)，等价于把相机 X 轴翻转到向右。
        if _need_flip_x_for_opencv_cam(cam2ego):
            # M' = FLIP_X · M ：只需把第 0 行取负
            flipped = list(ego2cam)
            for i in range(4):
                flipped[0 * 4 + i] = -flipped[0 * 4 + i]
            ego2cam = flipped
            out["extrinsic_axis_fix"] = "flip_x_left_down_forward_to_right_down_forward"

        out["extrinsic"] = ego2cam
        # 保留原始信息，便于调试与将来其他视图使用
        out["extrinsic_source_frame_id"] = frame_id
        out["extrinsic_semantics"] = "ego_to_camera"
    return out


def _load_camera_calib(scene_dir):
    """加载 calib/camera/*.json，返回 {camera_name: calib_dict}。"""
    calib_map = {}
    calib_dir = os.path.join(scene_dir, "calib", "camera")
    if not os.path.isdir(calib_dir):
        return calib_map
    for f in os.listdir(calib_dir):
        if not f.endswith(".json"):
            continue
        stem, _ = os.path.splitext(f)
        name = _camera_name_from_calib_file(stem)
        try:
            with open(os.path.join(calib_dir, f), "r") as fp:
                calib_map[name] = _normalize_camera_calib(json.load(fp))
        except Exception as e:
            print(f"[scene_reader] failed to load camera calib {f}: {e}")
    return calib_map


def get_one_scene(s):
    scene = {
        "scene": s,
        "frames": [],
    }

    scene_dir = os.path.join(root_dir, s)

    # 1) frames：从 lidar_center/ 里枚举
    scene["lidar_dir"] = LIDAR_DIR
    scene["lidar_ext"] = ".pcd"

    lidar_path = os.path.join(scene_dir, LIDAR_DIR)
    if os.path.isdir(lidar_path):
        for f in sorted(os.listdir(lidar_path)):
            stem, ext = os.path.splitext(f)
            if not stem or not ext:
                continue
            scene["frames"].append(stem)
            scene["lidar_ext"] = ext

    # 2) 可选：场景描述
    desc_file = os.path.join(scene_dir, "desc.json")
    if os.path.exists(desc_file):
        with open(desc_file) as f:
            scene["desc"] = json.load(f)

    # 3) cameras：扫描 camera_* 目录
    camera = []
    camera_ext = ""
    if os.path.isdir(scene_dir):
        for d in os.listdir(scene_dir):
            full = os.path.join(scene_dir, d)
            if not os.path.isdir(full):
                continue
            name = _camera_name_from_dir(d)
            if name is None:
                continue
            camera.append(name)
            if camera_ext == "":
                files = os.listdir(full)
                if files:
                    _, camera_ext = os.path.splitext(files[0])

    camera.sort()
    if camera_ext == "":
        camera_ext = ".jpg"

    scene["camera_ext"] = camera_ext
    scene["camera_dir_prefix"] = CAMERA_DIR_PREFIX
    scene["camera_dir_suffix"] = ""

    # 4) radar / aux_lidar 暂不参与 CCRS 流程，占位
    scene["radar_ext"] = ".pcd"
    scene["aux_lidar_ext"] = ".pcd"

    # 5) 标注 / 标定相关
    scene["boxtype"] = "psr"
    if camera:
        scene["camera"] = camera

    # 加载相机标定；前端 image.js 通过 sceneMeta.calib.camera[name] 获取内外参
    camera_calib = _load_camera_calib(scene_dir)
    scene["calib"] = {}
    if camera_calib:
        scene["calib"]["camera"] = camera_calib

    return scene


def read_annotations(scene, frame):
    filename = os.path.join(root_dir, scene, "label", frame + ".json")
    if os.path.isfile(filename):
        with open(filename, "r") as f:
            return json.load(f)
    return []


def read_ego_pose(scene, frame):
    filename = os.path.join(root_dir, scene, "ego_pose", frame + ".json")
    if os.path.isfile(filename):
        with open(filename, "r") as f:
            return json.load(f)
    return None


# 缓存已解析过的 odom 文件，避免每次前端请求都做一次 CSV parse。
# key: scene, value: (mtime, poses_list)
_odom_cache = {}


def read_odom(scene):
    """读取 clip 下的 odom/odom.csv，返回按 header_t_ns 升序排列的位姿列表。

    每条记录为 dict：`{"t_ns", "x", "y", "z", "yaw"}`。yaw 由四元数在 z 轴分量
    换算得到（本项目 odom 在平面上，只有绕 z 的偏航）。frame 名形如
    `"<sec>_<nsec>"`，其时间戳与 odom 的 `header_t_ns` 同源，因此前端可以直接把
    frame 名转成 ns 后在 poses 里做二分插值。

    找不到 odom 文件时返回 None（不是抛错），前端据此可以选择跳过位姿变换。
    """
    import csv
    import math

    odom_file = os.path.join(root_dir, scene, "odom", "odom.csv")
    if not os.path.isfile(odom_file):
        return None

    try:
        mtime = os.path.getmtime(odom_file)
    except OSError:
        mtime = None

    cached = _odom_cache.get(scene)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    poses = []
    try:
        with open(odom_file, "r", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    t_ns = int(row["header_t_ns"])
                    x = float(row["pose.pose.position.x"])
                    y = float(row["pose.pose.position.y"])
                    z = float(row["pose.pose.position.z"])
                    qx = float(row["pose.pose.orientation.x"])
                    qy = float(row["pose.pose.orientation.y"])
                    qz = float(row["pose.pose.orientation.z"])
                    qw = float(row["pose.pose.orientation.w"])
                except (KeyError, ValueError, TypeError):
                    continue

                # 四元数 -> 绕 z 轴 yaw（ZYX 约定下）。本数据 qx=qy≈0，公式退化为
                # 2*atan2(qz, qw)，但完整公式对更一般的场景也安全。
                yaw = math.atan2(
                    2.0 * (qw * qz + qx * qy),
                    1.0 - 2.0 * (qy * qy + qz * qz),
                )
                poses.append({
                    "t_ns": t_ns,
                    "x": x,
                    "y": y,
                    "z": z,
                    "yaw": yaw,
                })
    except Exception as e:
        print(f"[scene_reader] read_odom failed for scene={scene}: {e}")
        return None

    # 极少数情况下 CSV 不是严格递增，前端插值需要保证有序
    poses.sort(key=lambda p: p["t_ns"])

    _odom_cache[scene] = (mtime, poses)
    return poses



def save_annotations(scene, frame, anno):
    label_dir = os.path.join(root_dir, scene, "label")
    os.makedirs(label_dir, exist_ok=True)
    filename = os.path.join(label_dir, frame + ".json")
    with open(filename, 'w') as outfile:
        json.dump(anno, outfile)


if __name__ == "__main__":
    print(get_all_scenes())
