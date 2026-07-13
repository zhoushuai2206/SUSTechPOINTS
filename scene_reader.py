
import os
import json

try:
    import numpy as _np
except ImportError:  # numpy 是项目必备依赖，这里做保护性回退
    _np = None

this_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.join(this_dir, "data")

# 雷达目录候选，按优先级排列（新格式 lidar_center 优先）
LIDAR_DIR_CANDIDATES = ["lidar_center", "rslidar_points", "lidar"]
CAMERA_DIR_PREFIX = "camera_"

# 新版数据目录布局：data/<category>/<clip_name>/... ，其中 category 表示
# 该 clip 是单帧还是连续帧。为了向后兼容旧布局（data/<clip_name>/...），
# 这里既扫描已知 category 目录，也扫描 data/ 下直接就是 clip 的目录。
CATEGORY_DIR_NAMES = ("single_frame", "multi_frame")


def _detect_lidar_dir(scene_dir):
    """检测场景目录中实际存在的雷达数据目录名，按 LIDAR_DIR_CANDIDATES 优先级尝试。"""
    for d in LIDAR_DIR_CANDIDATES:
        if os.path.isdir(os.path.join(scene_dir, d)):
            return d
    return None


def _is_valid_clip_dir(clip_dir_abs):
    """判定一个绝对路径是否是合法的 clip 目录（有雷达子目录，且未被 disable）。"""
    if not os.path.isdir(clip_dir_abs):
        return False
    if os.path.exists(os.path.join(clip_dir_abs, "disable")):
        return False
    return _detect_lidar_dir(clip_dir_abs) is not None



def get_all_scenes():
    all_scenes = get_scene_names()
    print(all_scenes)
    return list(map(get_one_scene, all_scenes))


def get_all_scene_desc():
    names = get_scene_names()
    descs = {}
    for n in names:
        descs[n] = get_scene_desc(n)
    return descs


def _is_valid_scene(s):
    """有效场景必须为目录（可能带 category 前缀，如 "single_frame/clip_a"），
    包含已知雷达子目录之一，且未被 disable 文件禁用。"""
    # scene 名可能形如 "single_frame/2026_05_27-10_31_31"，
    # 用 os.path.join 之后仍是 root_dir 下的合法路径。
    scene_dir = os.path.join(root_dir, s)
    return _is_valid_clip_dir(scene_dir)


def get_scene_names():
    """扫描 data 目录，返回全部有效 clip 的名称列表。

    支持两种目录布局并可共存：
    - 新布局：data/<category>/<clip_name>/...，其中 category ∈ {single_frame, multi_frame}
      返回值形如 "single_frame/<clip_name>"，把 category 作为前缀带出去，
      这样后端 os.path.join(root_dir, scene) 与前端 `data/${scene}/...`
      的 URL 拼装都能自然工作。
    - 旧布局：data/<clip_name>/...
      返回值仍是纯 clip_name，保持向后兼容。
    """
    if not os.path.isdir(root_dir):
        return []

    scenes = []
    for entry in os.listdir(root_dir):
        entry_abs = os.path.join(root_dir, entry)
        if not os.path.isdir(entry_abs):
            continue

        if entry in CATEGORY_DIR_NAMES:
            # 新布局：进入 category 目录后继续枚举 clip
            for clip in os.listdir(entry_abs):
                clip_abs = os.path.join(entry_abs, clip)
                if _is_valid_clip_dir(clip_abs):
                    scenes.append(f"{entry}/{clip}")
        else:
            # 旧布局：data 下直接就是 clip
            if _is_valid_clip_dir(entry_abs):
                scenes.append(entry)

    scenes.sort()
    return scenes




def get_scene_desc(s):
    scene_dir = os.path.join(root_dir, s)
    if os.path.exists(os.path.join(scene_dir, "desc.json")):
        with open(os.path.join(scene_dir, "desc.json")) as f:
            desc = json.load(f)
            return desc
    return None


def _camera_name_from_dir(d):
    """从相机目录名中提取 camera 名（如 front/left/right/rear）。

    兼容两种命名：
    - 新格式：camera_<name>（如 camera_front）
    - 旧 CCRS 格式：camera_<name>_color（如 camera_front_color）
    """
    if not d.startswith(CAMERA_DIR_PREFIX):
        return None
    inner = d[len(CAMERA_DIR_PREFIX):]
    if not inner:
        return None
    # 旧格式：去掉 _color 后缀
    if inner.endswith("_color"):
        inner = inner[:-len("_color")]
    return inner or None


def _camera_dir_suffix_for_scene(scene_dir):
    """检测场景中相机目录使用的后缀（新格式 "" 或旧 CCRS 格式 "_color"）。"""
    if not os.path.isdir(scene_dir):
        return "_color"
    for d in os.listdir(scene_dir):
        if not os.path.isdir(os.path.join(scene_dir, d)):
            continue
        if d.startswith(CAMERA_DIR_PREFIX):
            inner = d[len(CAMERA_DIR_PREFIX):]
            if inner.endswith("_color"):
                return "_color"
            if inner:
                return ""
    return "_color"


def _camera_name_from_calib_file(stem):
    """从 calib/camera 目录下的 json 文件名推断相机名。

    兼容三种命名：
    - 新格式：camera_<name>.json（如 camera_front.json）
    - CCRS 旧格式：camera_<name>_color.json
    - 最老格式：<name>.json（如 front.json）
    """
    if stem.startswith(CAMERA_DIR_PREFIX):
        inner = stem[len(CAMERA_DIR_PREFIX):]
        if inner.endswith("_color"):
            inner = inner[:-len("_color")]
        if inner:
            return inner
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

    数据文件里 frame_id 形如 "camera2ego"、"lidar2ego" 表示原矩阵是 sensor→ego。
    前端 image.js 假设 extrinsic 直接作用于 3D 点得到相机系坐标，因此需要 ego→sensor。
    """
    if not isinstance(frame_id, str):
        return False
    fid = frame_id.strip().lower()
    return fid.endswith("2ego")


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
    """将不同格式的相机标定归一为前端期望的 {intrinsic:[9], extrinsic:[16], ...}。

    兼容格式：
    - 旧格式：{"intrinsic": [9], "extrinsic": [16]}
    - CCRS 新格式：{"intrinsic": {"cam_K": [9], "cam_dist": [...]}, "extrinsic": [16], ...}

    另外，新数据里 `extrinsic` 的语义由 `frame_id` 指定，例如 "camera2ego" 表示
    该矩阵把相机系点变换到 ego 系（T_ego←camera）。而 3D 标注框已经在 ego 系下，
    前端 image.js 的投影公式期望 extrinsic 是 T_camera←ego（即 ego→camera）。
    因此当 `frame_id` 以 "2ego" 结尾时，这里把 extrinsic 求逆再交给前端，保持前端
    代码语义不变，3D 框可直接与图像正确对齐。
    """
    if not isinstance(raw, dict):
        return raw

    out = dict(raw)  # 保留其他字段（image_width/height 等）以备将来使用
    intr = raw.get("intrinsic")
    if isinstance(intr, dict):
        # CCRS: 取 cam_K 作为 3x3 内参
        cam_k = intr.get("cam_K") or intr.get("K") or intr.get("cameraMatrix")
        if cam_k is not None:
            out["intrinsic"] = cam_k
        # 畸变系数单独暴露，前端目前未使用但保留
        cam_dist = intr.get("cam_dist") or intr.get("D") or intr.get("distCoeffs")
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
        "frames": []
    }

    scene_dir = os.path.join(root_dir, s)

    # 1) frames：自动检测雷达目录（lidar_center / rslidar_points / lidar）
    lidar_dir = _detect_lidar_dir(scene_dir) or LIDAR_DIR_CANDIDATES[0]
    lidar_path = os.path.join(scene_dir, lidar_dir)
    scene["lidar_dir"] = lidar_dir
    scene["lidar_ext"] = ".pcd"

    if os.path.isdir(lidar_path):
        frames = os.listdir(lidar_path)
        frames.sort()
        for f in frames:
            filename, fileext = os.path.splitext(f)
            if not filename or not fileext:
                continue
            scene["frames"].append(filename)
            scene["lidar_ext"] = fileext

    # 2) 可选：场景描述
    if os.path.exists(os.path.join(scene_dir, "desc.json")):
        with open(os.path.join(scene_dir, "desc.json")) as f:
            scene["desc"] = json.load(f)

    # 3) cameras：扫描 camera_* 目录，兼容新格式（无 _color）与旧格式（_color 后缀）
    camera = []
    camera_ext = ""
    camera_dir_suffix = _camera_dir_suffix_for_scene(scene_dir)
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
                if len(files) > 0:
                    _, camera_ext = os.path.splitext(files[0])

    camera.sort()
    if camera_ext == "":
        camera_ext = ".jpg"

    scene["camera_ext"] = camera_ext
    scene["camera_dir_prefix"] = CAMERA_DIR_PREFIX
    scene["camera_dir_suffix"] = camera_dir_suffix

    # 4) radar / aux_lidar 暂不处理，仅占位
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


def save_annotations(scene, frame, anno):
    label_dir = os.path.join(root_dir, scene, "label")
    os.makedirs(label_dir, exist_ok=True)
    filename = os.path.join(label_dir, frame + ".json")
    with open(filename, 'w') as outfile:
        json.dump(anno, outfile)


if __name__ == "__main__":
    print(get_all_scenes())
