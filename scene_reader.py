
import os
import json

this_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.join(this_dir, "data")

# 新数据格式（data/2026_03_17-09_17_31）目录约定
LIDAR_DIR = "rslidar_points"
CAMERA_DIR_PREFIX = "camera_"
CAMERA_DIR_SUFFIX = "_color"


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
    """有效场景必须为目录，包含 LIDAR_DIR 子目录，且未被 disable 文件禁用。"""
    scene_dir = os.path.join(root_dir, s)
    if not os.path.isdir(scene_dir):
        return False
    if os.path.exists(os.path.join(scene_dir, "disable")):
        return False
    if not os.path.isdir(os.path.join(scene_dir, LIDAR_DIR)):
        return False
    return True


def get_scene_names():
    if not os.path.isdir(root_dir):
        return []
    scenes = [s for s in os.listdir(root_dir) if _is_valid_scene(s)]
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
    """从 camera_<name>_color 目录名中提取 camera 名（如 front/left/right/rear）。"""
    if not (d.startswith(CAMERA_DIR_PREFIX) and d.endswith(CAMERA_DIR_SUFFIX)):
        return None
    name = d[len(CAMERA_DIR_PREFIX):-len(CAMERA_DIR_SUFFIX)]
    return name or None


def get_one_scene(s):
    scene = {
        "scene": s,
        "frames": []
    }

    scene_dir = os.path.join(root_dir, s)

    # 1) frames：以 rslidar_points 目录下的点云文件名作为 frame id
    lidar_path = os.path.join(scene_dir, LIDAR_DIR)
    scene["lidar_dir"] = LIDAR_DIR
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

    # 3) cameras：扫描 camera_*_color 目录
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
                if len(files) > 0:
                    _, camera_ext = os.path.splitext(files[0])

    camera.sort()
    if camera_ext == "":
        camera_ext = ".jpg"

    scene["camera_ext"] = camera_ext
    scene["camera_dir_prefix"] = CAMERA_DIR_PREFIX
    scene["camera_dir_suffix"] = CAMERA_DIR_SUFFIX

    # 4) radar / aux_lidar 暂不处理，仅占位
    scene["radar_ext"] = ".pcd"
    scene["aux_lidar_ext"] = ".pcd"

    # 5) 标注 / 标定相关：标定参数暂不接入
    scene["boxtype"] = "psr"
    if camera:
        scene["camera"] = camera

    scene["calib"] = {}

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
