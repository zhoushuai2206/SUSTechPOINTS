# 自动标注（pre_annotate）后端集成说明

`/auto_annotate` 与 `/predict_rotation` 的唯一后端是 **OpenPCDet 的 CenterPoint** 模型
（默认 `cbgs_dyn_pp_centerpoint.yaml`，nuScenes 10 类 + PointPillars backbone）。启动脚本
`bash start.sh` 会在首次运行时自动调用 `setup_env.sh` 完成：

1. 独立 conda env `annotate`（Python 3.10）+ `requirement.txt`
2. `cuda-toolkit=11.8`（conda 装到 env 内，nvcc/cudart 齐全，不污染 base）
3. `torch==2.1.0` + `spconv-cu118`（可 `--cuda 12.1 / 11.7` 切换，注意同步换 cuda-toolkit 版本）
4. 克隆 `third_party/OpenPCDet` 并 `python setup.py develop`
5. 下载 CenterPoint 权重到 `algos/models/centerpoint_pp.pth`
6. 导入自检 + `.setup_done` 标记

前提是宿主机已安装 Anaconda 或 Miniconda。手动激活环境：`conda activate annotate`。

安装完成后前端点 `Auto Annotate` 就直接跑深度模型，不再走任何兜底路径。

## 1. 架构

```
public/js/auto_annotate.js  ──GET /auto_annotate──▶  main.py
public/js/ml.js:predict_rotation ──POST /predict_rotation──▶  main.py
                                                    │
                                                    ▼
                              algos/pre_annotate.py（薄壳）
                                                    │
                                                    ▼
                              algos/detectors/get_detector()
                                                    │
                                                    ▼
                              algos/detectors/openpcdet_detector.py
                              (OpenPCDetDetector → torch + OpenPCDet)
```

关键文件：

| 路径 | 作用 |
|---|---|
| `algos/pre_annotate.py` | 对外 API：`annotate_file` / `predict_yaw` / `get_status` |
| `algos/pcd_io.py` | 极简 PCD 读取器（ascii/binary，支持 RSLidar padding 字段）|
| `algos/detectors/__init__.py` | 单例入口 `get_detector()`；backend 固定 openpcdet |
| `algos/detectors/base.py` | `BaseDetector` / `Detection` 数据类 |
| `algos/detectors/openpcdet_detector.py` | CenterPoint 适配层 |
| `algos/detectors/geometry.py` | 单物体 yaw fallback（L-shape）|
| `algos/detector_config.json` | 后端参数（config_path / ckpt_path / class_map 等）|

## 2. 状态查询

```bash
curl http://127.0.0.1:8081/ml_status
```

返回：

```json
{
  "backend": "openpcdet",
  "available": true,
  "info": "OpenPCDetDetector(cfg=..., ckpt=..., device=cuda:0, available=True)",
  "load_error": null
}
```

`available=false` 时 `load_error` 会给出具体原因（多半是 torch/spconv 版本、权重缺失或路径错）。

## 3. 类别映射

CenterPoint 输出 nuScenes 10 类，`detector_config.json` 里的 `class_map` 把它们映射到前端
`public/js/obj_cfg.js` 的枚举：

| CenterPoint 原始类 | 前端类别 |
|---|---|
| car / vehicle | Car |
| truck / trailer / construction_vehicle | Truck |
| bus | Bus |
| motorcycle | Motorcycle |
| bicycle | Bicycle |
| pedestrian | Pedestrian |
| traffic_cone | Cone |
| barrier | TrafficBarrier |

对于 CCRS 特有类（Scooter、Trimotorcycle、ForkLift 等），CenterPoint 不会输出，需要人工新建，
再靠 Batch Edit 里 Interpolate 传播。

## 4. 数据布局兼容

`main.py:_resolve_pcd_path` 会依次尝试：

1. `scene_reader.get_one_scene(scene)` 报告的 `lidar_dir/lidar_ext`（新数据 `lidar_center/*.pcd`）
2. 候选目录 `rslidar_points`、`lidar`
3. 候选后缀 `.pcd`、`.bin`

所以旧的 `data/<scene>/lidar/<frame>.pcd`、CCRS 的 `rslidar_points/*.pcd`，以及新格式
`lidar_center/*.pcd` 都能被 `/auto_annotate` 找到。

## 5. 换模型 / 换权重

只需改 `algos/detector_config.json` 的 `openpcdet` 段：

```json
{
  "backend": "openpcdet",
  "openpcdet": {
    "config_path": "third_party/OpenPCDet/tools/cfgs/waymo_models/centerpoint.yaml",
    "ckpt_path":   "algos/models/waymo_centerpoint.pth",
    "class_names": ["Vehicle", "Pedestrian", "Cyclist"],
    "score_thresh": 0.35,
    "device": "cuda:0",
    "num_point_features": 5,
    "class_map": {
      "Vehicle": "Car",
      "Pedestrian": "Pedestrian",
      "Cyclist": "BicycleRider"
    }
  }
}
```

`num_point_features` 需与 config 里 `POINT_CLOUD_RANGE` 附近定义的输入维度一致。修改完
`bash start.sh --stop && bash start.sh` 生效。

## 6. 已知限制

1. CenterPoint 是 nuScenes 域权重，对 CCRS 内部特有类别（Scooter、Trimotorcycle 等）几乎没有召回；
   建议后续用自家标注数据 fine-tune。
2. `/auto_annotate` 是同步接口。若模型较大、单帧推理接近秒级，前端体验会退化，可考虑后续改成
   异步任务队列。
3. `predict_yaw` 在 CenterPoint 场景检测的语义下不合适，代码里已经 fallback 到几何
   L-shape（`geometry.estimate_yaw_lshape`）来估单物体点云的 yaw。

## 7. 一键排错

| 现象 | 排查 |
|---|---|
| `/ml_status` 里 `available=false` | 看 `load_error`；多半是 spconv/torch 版本不匹配或 ckpt 缺失 |
| 前端点自动标注没反应 | 打开浏览器控制台看 XHR；`curl /ml_status`；查看 `server.log` |
| `pcd not found` 404 | 检查 `data/<scene>/` 里雷达子目录（`lidar_center` / `rslidar_points` / `lidar`）与 frame 名 |
| GPU OOM | 把 `device` 改成 `cuda:1` 或 `cpu`；或减少 `class_names` |
| 检测框类别都错 | 核对 `class_map` 是否覆盖当前模型的所有输出类 |
