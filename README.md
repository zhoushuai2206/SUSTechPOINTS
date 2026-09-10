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
bash start.sh --env NAME      # 指定 conda env 名（默认 bevfusion）
```

首次启动 `start.sh` 会检查 conda env `bevfusion` 是否存在（复用 BEVFusion 项目那一份即可，需要包含 `onnxruntime`, `numpy`, `cherrypy`, `jinja2`, `cheroot`, `filterpy`），随后启动 CherryPy 服务。可用 `--env NAME` / `SUSTECH_CONDA_ENV` 切换到其他 env。

启动完成后打开 <http://127.0.0.1:8081>。

## 目录

- `main.py` / `scene_reader.py`：CherryPy web 服务与 CCRS clip 读取
- `algos/`：本地 BEVFusion ONNX 自动标注（PointPillars + CenterHead 0.2m）
  - `algos/models/model.onnx` / `.meta.json`：模型及输出布局元数据
  - `algos/onnx_detector.py`：ORT 会话、pillar 化、CenterPoint 解码
  - `algos/nms.py` / `algos/pcd_io.py`：旋转 NMS 与 PCD 读取
- `tools/check_labels.py`：标注一致性检查
- `public/`：前端（three.js 主视图 + 三视图 + 相机投影）
- `doc/annotation_best_practice.md`：标注流程与技巧

## 半自动标注

模型来源：`/home/zhou/Program/BEVFusion/runs/ccrs_lidar_only_car_0.2m_eval/model.onnx`；启动服务前先拷贝到 `algos/models/model.onnx`（`start.sh` 会打印缺失警告）。

前端右键 `Auto Annotate` 提供：

- `Detect`：调 `/auto_annotate?scene=&frame=`，对当前帧刷候选框（覆盖并保存当前帧）。
- `Detect Clip`：调 `/auto_annotate_scene?scene=&save=1`，服务器串行推理整段 clip 并落盘 `label/*.json`；完成后已加载的帧会自动重新拉一遍标注。返回 JSON 形如 `{status, scene, total_frames, frames:[{frame,count,error?}]}`。
- `ID`：clip 级单调递增，重分配未赋值 / 冲突的 track id。

`GET /ml_status` 输出模型路径、加载状态、当前 ONNX Runtime provider 等信息。当 `bevfusion` env 缺 `libcudnn.so.9` 时，ORT 会自动回退到 `CPUExecutionProvider`。若需切换，可设 `SUSTECH_ONNX_PROVIDER` / `SUSTECH_ONNX_SCORE_THRESHOLD` / `SUSTECH_ONNX_MODEL` 环境变量。
