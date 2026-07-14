# SUSTechPOINTS (CCRS)

CCRS 格式点云 3D 标注工具，基于 SUSTechPOINTS 精简而来，只保留 CCRS 数据布局的支持。

## 数据布局

```
data/
    single_frame/
        <clip_name>/
            calib/{camera,lidar}/*.json
            camera_<name>/*.jpg
            lidar_center/*.pcd
            imu/                 # 可选
            motion_state/        # 可选
            label/<frame>.json   # 3D 框标注
            ego_pose/<frame>.json # 可选
            desc.json            # 可选
    multi_frame/<clip_name>/...
```

- 相机标定格式：`{"intrinsic": {"cam_K": [9], "cam_dist": [...]}, "extrinsic": [16], "frame_id": "camera2ego"}`。当 `frame_id` 以 `2ego` 结尾时，`scene_reader.py` 会自动求逆得到 `ego2cam` 供前端使用。
- 3D 标注框保存在 ego 坐标系（FLU：X 前、Y 左、Z 上），`psr.rotation.z` 是 yaw。

## 启动

```bash
bash start.sh                 # 前台启动
bash start.sh -d              # 后台启动
bash start.sh --stop          # 停止后台进程
bash start.sh --skip-setup    # 跳过依赖自动安装
```

首次启动 `start.sh` 会自动调用 `setup_env.sh`：创建 conda env `annotate`、装齐 web 依赖 + `cuda-toolkit=11.8` + `torch==2.1.0` + `spconv-cu118` + OpenPCDet + CenterPoint 权重。

启动完成后打开 <http://127.0.0.1:8081>。

## 目录

- `main.py` / `scene_reader.py`：CherryPy web 服务与 CCRS clip 读取
- `algos/`：半自动标注后端（OpenPCDet + CenterPoint）
- `tools/check_labels.py`：标注一致性检查
- `public/`：前端（three.js 主视图 + 三视图 + 相机投影）
- `doc/annotation_best_practice.md`：标注流程与技巧

## 半自动标注

前端右键 `Auto Annotate → Detect` 会调 `/auto_annotate` 让 CenterPoint 给当前帧刷候选框。`ID` 项会按 clip 级单调递增原则给未赋值 / 冲突的框重新分配 track id。

`GET /ml_status` 可查看 OpenPCDet 后端加载状态。
