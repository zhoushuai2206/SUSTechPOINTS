# 半自动标注（pre_annotate）后端集成说明

`/auto_annotate` 与 `/predict_rotation` 的后端从原来的旧版 Keras 模型
（`algos/models/deep_annotation_inference.h5`，Keras 3 下已无法反序列化）改造为
**可插拔检测器架构**。核心目标：

1. 服务永远可用：默认落到纯 numpy 的几何聚类兜底后端（DummyDetector），不再 500。
2. 想要真正的深度模型能力时，装好 [OpenPCDet](https://github.com/open-mmlab/OpenPCDet)
   + 权重，改一行配置即切换（CenterPoint / PointPillars / PV-RCNN 都可以）。

## 1. 架构总览

```
public/js/auto_annotate.js  ──GET /auto_annotate──▶  main.py
public/js/ml.js:predict_rotation ──POST /predict_rotation──▶  main.py
                                                    │
                                                    ▼
                              algos/pre_annotate.py（薄壳，保留旧 API）
                                                    │
                                                    ▼
                              algos/detectors/get_detector()
                                        │
                            ┌───────────┴───────────┐
                            ▼                       ▼
                DummyDetector（默认）    OpenPCDetDetector（可选）
                geometry.py：           torch + OpenPCDet
                  地面剔除→聚类→L-shape
```

关键文件：

| 路径 | 作用 |
|---|---|
| `algos/pre_annotate.py` | 对外 API 兼容层：`annotate_file` / `predict_yaw` / `get_status` |
| `algos/pcd_io.py` | 极简 PCD 读取器（ascii/binary，支持 RSLidar 的 padding 字段）|
| `algos/detectors/__init__.py` | 检测器注册 + 单例入口 `get_detector()` |
| `algos/detectors/base.py` | `BaseDetector` / `Detection` 数据类，`to_sustech_json()` |
| `algos/detectors/geometry.py` | 地面剔除、体素聚类、L-shape、点云→3D box |
| `algos/detectors/dummy.py` | 零依赖兜底检测器 |
| `algos/detectors/openpcdet_detector.py` | OpenPCDet 适配层，延迟加载 torch |
| `algos/detector_config.json` | 后端选择与参数（也可通过环境变量 `SUSTECH_DETECTOR` 覆盖）|

## 2. 排查方式

服务启动后访问 `http://<host>:8081/ml_status`：

```json
{
  "backend": "dummy_cluster",
  "available": true,
  "info": "DummyDetector（几何聚类兜底）...",
  "load_fallback_reason": null,
  "legacy_model_file": "./algos/models/deep_annotation_inference.h5",
  "legacy_model_available": true
}
```

- `backend`：当前实际使用的后端名。
- `load_fallback_reason`：如果切到 openpcdet 失败并回退到 dummy，这里会给出原因。
- 若前端点"自动标注"没反应或报错，先 curl `/ml_status`，再看服务端日志（`server.log`）。

## 3. 切换到 OpenPCDet（推荐 PointPillars 起步）

### 3.1 安装

在**独立**的 conda/venv 环境里安装（不要污染 `tf_env`）：

```bash
# 1) 创建独立环境
conda create -n pcdet python=3.10 -y
conda activate pcdet

# 2) 装 torch（按你的 CUDA 版本选 wheel）
pip install torch==2.1.0 torchvision==0.16.0 --index-url https://download.pytorch.org/whl/cu118

# 3) 装 spconv（与 CUDA 版本对齐）
pip install spconv-cu118

# 4) 装 OpenPCDet
git clone https://github.com/open-mmlab/OpenPCDet.git third_party/OpenPCDet
cd third_party/OpenPCDet
pip install -r requirements.txt
python setup.py develop
cd ../..

# 5) 下载权重（示例：PointPillars KITTI）
mkdir -p algos/models
wget -O algos/models/pointpillar_7728.pth \
  https://drive.google.com/uc?id=1wMxWTpU1qUoY3DsCH31WJmvJxcjFXKlm
# 也可以换 CenterPoint / PV-RCNN，凡是 OpenPCDet cfg + ckpt 都可
```

> 如果 SUSTechPOINTS 服务本身用的是 `tf_env`，那这个 pcdet 环境要么用同一个 python
> 版本合并（把 torch/spconv/pcdet 也装到 tf_env 里），要么把 `main.py` 用
> pcdet 环境的 python 起。**推荐后者**：SUSTechPOINTS 只是 CherryPy，什么 python 都能跑。

### 3.2 启用

编辑 `algos/detector_config.json`：

```json
{
  "backend": "openpcdet",
  "openpcdet": {
    "config_path": "third_party/OpenPCDet/tools/cfgs/kitti_models/pointpillar.yaml",
    "ckpt_path":   "algos/models/pointpillar_7728.pth",
    "class_names": ["Car", "Pedestrian", "Cyclist"],
    "score_thresh": 0.3,
    "device": "cuda:0",
    "num_point_features": 4,
    "class_map": {
      "Car": "Car",
      "Pedestrian": "Pedestrian",
      "Cyclist": "BicycleRider"
    }
  }
}
```

也可以临时用环境变量：`SUSTECH_DETECTOR=openpcdet python main.py`。

启动后再 curl `/ml_status`，应该看到 `"backend": "openpcdet"`；如果失败，会自动
回退到 dummy 并把原因写进 `load_fallback_reason`。

### 3.3 类别映射说明

OpenPCDet 常见配置输出 3 类（KITTI）或 5 类（nuScenes / Waymo），而
SUSTechPOINTS 前端 `public/js/obj_cfg.js` 定义了几十类。`class_map` 用来把
模型输出映射到前端里已存在的类别名，找不到的类别会原样透传，标注员在前端
可再手动改类型。

## 4. 数据布局兼容

`main.py:_resolve_pcd_path` 会依次尝试：

1. `scene_reader.get_one_scene(scene)` 报告的 `lidar_dir/lidar_ext`（新数据是
   `rslidar_points/*.pcd`）；
2. 常见候选目录：`rslidar_points`、`lidar`；
3. 常见候选后缀：`.pcd`、`.bin`。

所以 `data/<scene>/rslidar_points/<frame>.pcd` 与旧的
`data/<scene>/lidar/<frame>.pcd` 都能被 `/auto_annotate` 找到。

## 5. 已知限制

1. DummyDetector 依赖 z 轴地面直方图剔除地面，坡道/隧道等场景可能会把地面留下来
   变成一个大 cluster。这时前端删掉即可，或调低 `detector_config.json` 里的
   `ground_margin`。
2. L-shape 只能给出 `[-π/2, π/2]` 的 yaw；朝向前后二义性由标注员在前端一键翻转。
3. OpenPCDet 权重的域差异（KITTI/Waymo 数据 vs 你的 RSLidar 数据）会导致召回率
   下降，尤其是行人/骑行者。想要生产可用，建议用你们已有的标注数据 fine-tune。
4. `/auto_annotate` 目前是同步接口。若切换到 OpenPCDet 且模型很大，单帧推理耗时
   到秒级，前端体验会变差。这一层将来可以按需改成异步任务队列。

## 6. 一键排错清单

| 现象 | 排查 |
|---|---|
| 前端点自动标注没反应 | 打开浏览器控制台看 XHR 状态；命令行 `curl /ml_status` |
| `pcd not found` 404 | 检查 `data/<scene>/` 目录结构是否有 `rslidar_points/` 或 `lidar/` |
| 一直落到 dummy | 看 `/ml_status` 里 `load_fallback_reason`，通常是 torch/spconv 版本不匹配 |
| Predict rotation 输出全是 0 | 传的点数少于 3，或不是 (N,3) 格式 |
| 检测框都很小/框到地面 | 调高 `dummy.min_cluster_pts` / `ground_margin` |
