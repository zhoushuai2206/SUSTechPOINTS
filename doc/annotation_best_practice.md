# Clip 数据标注最佳实践

以 `data/2026_05_27-10_32_01` 为例，说明在当前工程里如何组合"人工 + 自动工具"最高效地完成一个 clip 的 3D 标注。适用于所有符合 CCRS 新格式（`lidar_center/`、`camera_*/`、`calib/{camera,lidar}/`、`label/`、`imu/`、`motion_state/`）的 clip。

---

## 0. 该 clip 的现状速览

```
data/2026_05_27-10_32_01/
├── calib/
│   ├── camera/camera_front.json
│   └── lidar/lidar_center.json
├── camera_front/           # 200+ 张 jpg
├── imu/
├── label/
│   └── 1851_763310976.json # 只有 1 帧已标注（可作为锚定帧）
├── lidar_center/           # 200+ 个 pcd
└── motion_state/
```

特点：
- 单前视相机 + 单中央雷达。
- label 只有 1 帧，需要从头把整个 clip 标满。
- 标注坐标系是 ego（前左上，FLU），`psr` 里 `rotation.z` 就是 yaw。
- `scene_reader.py` 已经把 `camera2ego` 外参自动求逆并按需翻转 X 轴，前端 3D 框可以直接投影到图像。

---

## 1. 标注前的准备（一次性）

### 1.1 启动服务（自动装齐 CenterPoint 全栈）

第一次拉到项目后直接：

```bash
bash start.sh
```

`start.sh` 会检测 conda env `annotate`、OpenPCDet 目录、`algos/models/centerpoint_pp.pth` 权重是否存在；缺任一项都会自动调用 `setup_env.sh` 完成：

1. 创建独立 conda env `annotate`（Python 3.10）并装齐 Web 服务依赖（`requirement.txt`）
2. 在该 env 里装 `cuda-toolkit=11.8`（nvcc/cudart/cusparse/cublas 齐全，不污染 base，不需要 root）
3. 按 `--cuda`（默认 11.8）装 `torch==2.1.0` + `spconv-cu118`
4. 克隆并编译安装 `third_party/OpenPCDet`
5. 下载 CenterPoint(PointPillars, nuScenes) 权重到 `algos/models/centerpoint_pp.pth`
6. 跑一遍导入自检并写入 `.setup_done` 标记

前提是系统已安装 Anaconda 或 Miniconda。想手动激活环境：`conda activate annotate`。

装好后自动起服务，浏览器打开 `http://127.0.0.1:8081`。

验证后端是否就绪：

```bash
curl http://127.0.0.1:8081/ml_status
# 期望: {"backend": "openpcdet", "available": true, "info": "OpenPCDetDetector(...)", "load_error": null}
```

`available=false` 或 `load_error` 不为空 → 先看 `server.log`，多半是 CUDA/spconv/权重路径问题，改好再标。

如果 CUDA 版本不是 11.8：

```bash
bash setup_env.sh --cuda 12.1 --force
```

### 1.2 校准可视化对齐

打开一次场景，随便新建一个框，看它在 `camera_front` 图像上的投影是否对得上物体。对不齐先查 `calib/camera/camera_front.json` 里 `frame_id`（新格式一般是 `camera2ego`）和内参的 `cam_K`，不要在错误的标定上标数据。

### 1.3 clip 级规范

- 类别名严格用 `public/js/obj_cfg.js` 的枚举，当前只保留 8 类：Car / Truck / Bus / Motorcycle / Bicycle / Pedestrian / Cone / ForkLift。
- 每个物体一个全局 `obj_id`（tracking id），一个 clip 内不复用。
- 物体尺寸尽量与 `obj_cfg.js` 默认 size 一致，方便后续 `sync object size` 一键铺满。

---

## 2. 关键帧标注（3–5 帧）

从整个 clip 选 3–5 个"关键帧"：至少包含起始帧、结束帧，以及中间物体最全、遮挡最少的 1–3 帧。当前 clip 建议：clip 起始帧 + 已存在的 1851 帧 + clip 末尾帧。

### 2.1 一键预标注（种子）：CenterPoint 全自动预刷

前端有 4 个入口，全都最终调 `GET /auto_annotate?scene=<clip>&frame=<frame>`，直连 `algos.detectors.openpcdet_detector.OpenPCDetDetector`（CenterPoint / nuScenes 10 类 + PointPillars backbone）：

- **主视图空白处右键 → `Auto Annotate` → `Detect`**（`cm-auto-annotate-detect`）：对当前帧点云跑 CenterPoint，**结果覆盖当前帧标签并自动保存到 `label/<frame>.json`**。菜单像 Play 一样带右侧下侧展开的子菜单，同一层还有 `ID`（下面 2.6 节说明）。**这是最常用的单帧一键补种入口。**
- **主视图选中 box 后右键 → `Auto annotate in background`**（`cm-auto-ann-background`）：对该 box 对应的 tracking id 在整段 clip 上做插值 + 自动微调，只影响这一个 obj，不覆盖别的 box。
- **Batch Edit 顶栏按钮**：右上角 `Auto`（对整批 M 标记帧统一跑）。
- **Batch Edit 右键菜单**：`Auto annotate` / `Auto annotate (no rotation)`。

返回的候选框 JSON 通过 `class_map` 已经映射到前端枚举。当前 `obj_cfg.js` 只保留 8 类（Car / Truck / Bus / Motorcycle / Bicycle / Pedestrian / Cone / ForkLift），映射规则如下：

| CenterPoint 原始类 | 映射到 obj_cfg.js |
|---|---|
| car | Car |
| truck / trailer / construction_vehicle | Truck |
| bus | Bus |
| motorcycle | Motorcycle |
| bicycle | Bicycle |
| pedestrian | Pedestrian |
| traffic_cone | Cone |
| barrier | （不映射，原样透传为 `barrier`，标注员在前端手动改类别或删除） |

`ForkLift` 是本项目独有类别，需要标注员在前端手动新建。当前本地 CCRS lidar-only ONNX 模型只训练了 `car` 一类，自动检测结果会保留后端返回的 `Car`，不会再按尺寸猜成 `Motorcycle` / `Bicycle`。**候选框只是种子，方向和尺寸仍需手工过一遍**，尤其是远端遮挡目标。

想批量给整个 clip 预刷，直接在批量编辑（Batch Edit）里跑一次 `Auto`——它会对 M 标记帧逐帧调用同一后端。也可以在每一关键帧上依次右键 `Auto Annotate → Detect` 逐帧跑，得到干净的检测种子后再进 Batch Edit 做插值。若 CenterPoint 推理耗时不理想，可在 `algos/detector_config.json` 里把 `score_thresh` 从 0.3 调高到 0.4~0.5 减少后处理，或换 `device: "cpu"` 用于无 GPU 机器（速度会掉到秒级/帧）。

调优路径：
- 想换权重（例如自家 fine-tune 版）：把 `.pth` 覆盖 `algos/models/centerpoint_pp.pth` 后 `bash start.sh --stop && bash start.sh`。
- 想换成 CenterPoint-Voxel / PV-RCNN 等其它模型：改 `detector_config.json` 里 `config_path` 到 `third_party/OpenPCDet/tools/cfgs/` 下对应 yaml，把 `ckpt_path` 指到相应权重即可。

### 2.2 快速补框

- 视角调到接近鸟瞰（远处点选中越少越好）。
- **`Ctrl + 左键框选`**：region grow + L-shape，自动出 yaw。
- **`Shift + 左键框选`**：只出无自动拟合的框，用于地面倾斜或 region grow 效果差的场景。
- **右键 → New → 类别**：在鼠标位置直接创建。

### 2.3 精修 3 项

- 朝向反了：`g` 翻 180°。
- 尺寸不贴：在鸟瞰/侧/后子视图双击边界，自动贴最近内点。
- 位置漂移：`Ctrl + 拖动` 单侧自动收缩；`Shift + 拖动` 保尺寸平移。

### 2.4 补齐关键字段

- 类别：从 `obj_cfg.js` 枚举里选。
- `obj_id`：一次性分配好全局 tracking id，后面所有帧就靠它串联。
- 属性：如 `Pedestrian` 的 `sitting`、`squating` 等，按需要在快速工具栏里勾。

### 2.5 保存

`Ctrl + S`。

关键帧标完，clip 的"字典"就有了：每个物体的类别、ID、参考尺寸都固定，后面只是把它们复制并微调到剩余帧。

### 2.6 一键分配 track id：`Auto Annotate → ID`

`Auto Annotate` 子菜单里的 `ID`（`cm-auto-annotate-id`）用于修复当前帧里非法或缺失的 tracking id，遵循 **clip 级 id 单调递增** 原则：

**核心原则**：整段 clip 里历史上用过的 id，即便对应物体已经不在当前视野里，也不能复用。id 只允许从历史最大值往后增长。

**自动分配逻辑**：
1. 收集整段 clip（当前 scene）所有已使用 id：遍历已加载帧所有 box 的 `obj_track_id` + `objIdManager`（覆盖未加载帧的 id 记录，来自后端 `/objs_of_scene`）。
2. 保留当前帧"合理 id"：正整数且在本帧内唯一。
3. 需要重分配的 box（空 id / 非正整数 / 本帧重复）：从 `max(clip_all_ids) + 1` 开始往后顺序分配，保证严格递增、不复用历史 id。
4. 只保存当前帧，不连带修改其他帧。
5. 日志窗输出：`[auto-id] box(Car) id: "3" → 27`，方便事后审查。

**手动输入校验**：在 track id 输入框里手动输入 id 时，如果该 id 已被 clip 里其他物体使用过（哪怕对应帧还没加载），会弹出提示并恢复原值，防止复用历史 id。

典型场景：
1. `Detect` 刚跑完，一堆新框还没 id → 直接跑 `ID`，新框会从 clip 历史最大 id+1 开始依次编号。
2. 从别处拷贝的 label 出现 id 冲突 → 一键把冲突方改到安全的新 id。
3. 人工新建时手滑输了已存在的 id → 输入框立即提示并恢复原值。

**注意**：这个操作只修当前帧，跨帧的 tracking 关联仍要靠 Batch Edit 的 `Follow Ref` / `Change ID to Ref in all frames`。典型工作流：先跑 `Detect` 补框 → 跑 `ID` 把 id 赋好 → 用 Batch Edit 把跨帧的同一物体 id 统一。

---

## 3. 跨帧传播：Batch Edit 是主战场

对每个物体（按 `obj_id`）逐个处理：

1. 选中该物体的框 → 右键 → **`inspect all instances`**，进入 Batch Edit（默认一次显示 20 帧，10 帧重叠）。
2. 右上角按钮组合使用：
   - **Auto**：对所有 M 标记（machine）帧跑自动标注，位置和 yaw 由后端给。适合遮挡少、召回好的物体。
   - **Interpolate**：在人工确认过的帧之间做位置/尺寸/yaw 的线性插值。**静态物体和匀速物体最快、最稳。**
   - **Auto(no rotation)**：只更新位置，不动 yaw。yaw 已经手工调好的情况用。
3. 逐窗巡检 20 个小窗：
   - 尺寸抖动：右键 `sync object size` 把整段设为同一 scale。
   - yaw 反：mouse-over 到该窗 `g`。
   - 位置偏：`Ctrl+drag` 或 `r/f`（旋转 + 自动拟合）。
   - 明显错误：mouse-over + `Ctrl+D` 删除后回主视图重建。
4. **Finalize**：把所有自动/插值框标记为"已人工确认"（去掉 M）。之后再点 Auto/Interpolate 不会覆盖它们。**必做，否则下一次批量操作会把你的手工修改冲掉。**
5. **Save** → **Next** 翻下一批。

`config.js` 里 `autoUpdateInterpolatedBoxes = true`，改动某帧后相邻插值帧会自动重算，可以放心动关键帧。

### 建议的物体处理顺序

1. 静态物体（Cone、建筑物旁的停车 Car、静止 ForkLift）→ 纯 Interpolate。
2. 匀速运动物体（远处的 Car / Bus / Truck）→ Interpolate + 少量 Auto。
3. 变向/加减速物体（近处的 Car / ForkLift）→ 多设几个人工关键帧后 Interpolate。
4. 行人 / 骑行者（Pedestrian / Motorcycle / Bicycle）→ 视情况 Auto，多数需要多锚点手工。

---

## 4. tracking id 的高效管理

- 新建框立即分配 tracking id，避免最后回头补。
- 同一物体在不同帧**不要重复 `New`**，用 Batch Edit 的 `Interpolate` 生成新帧的框。
- 类别改动后用右键 `sync object type` 一键同步全 clip 该 ID。
- 尺寸稳定后用 `sync object size` 一键同步。

---

## 5. 错检与验收

标完 clip 后跑一遍工程自带的 checker：

```bash
python tools/check_labels.py data/2026_05_27-10_32_01
```

它会检查：
- `obj_type` 不在枚举里
- `obj_id` 为空
- 同一帧 `obj_id` 重复
- 同一物体尺寸抖动超 ±5%（Pedestrian 除外）
- 相邻帧 yaw 变化超 30°
- 同一 id 类别不一致

按报告逐条回编辑器修。

---

## 6. 效率对比（200 帧、10 个物体 clip 估算）

| 做法 | 大致耗时 |
|---|---|
| 纯人工每帧新建 | 6–10 小时 |
| 人工关键帧 + Batch Interpolate + Finalize | 1–1.5 小时 |
| CenterPoint 全 clip 预刷 + 人工关键帧修边 + Batch Interpolate/Finalize | 25–40 分钟（行人/骑行仍需人工兜） |

---

## 7. 针对本 clip 的额外提示

- 只有前视相机，clip 尾部远处物体的投影会退化，以 lidar 主视图为准，图像做类别/朝向辅助验证。
- 已有的 1851 帧是天然的中段锚点，直接以它为基准向前向后 Interpolate 最省事。
- CenterPoint 是 nuScenes 域训练的，对于本项目独有的 `ForkLift` 召回为 0，这类物体走人工新建，然后依赖 Batch Interpolate 传播。
- CenterPoint 有时会输出 nuScenes 里的 `barrier` 类，因为它不在 obj_cfg.js 枚举里，前端会显示原始类名，标注员看到时改成合适类别或直接删除即可。
- 如果 CenterPoint 推理占显存太多，可将 `algos/detector_config.json` 里 `device` 改成 `cuda:1` 或 `cpu`；也可以在 `class_names` 里去掉不关心的类以减小后处理开销。
- `motion_state/` 和 `imu/` 目录当前工程未参与标注流水线，可用作后续做基于 ego motion 的运动补偿或轨迹平滑（自定义脚本）。
- Label 文本（如 `Car 16`）现在锚定在 box **车头顶棱的中点上方**（`floatlabel.js` 的 `compute_best_position` 取 box 顶点 2/3 的中点，CSS 用 `transform: translate(-50%, -100%)` 把 label 底边中心贴上去）。BEV 里就是每个 box 前边正上方，用来直观判断朝向；侧视/透视也会跟随 box 旋转贴到真实车头棱上。

---

## 8. 快捷键速查

主视图/子视图（mouse-over 到该视图有效）：

| 键 | 操作 |
|---|---|
| `Ctrl + 左键拖` | 新建框（region grow + 自动拟合） |
| `Shift + 左键拖` | 新建框（无自动拟合） |
| `a/s/d/w` | 左/下/右/上平移 |
| `q/e` | 逆/顺时针旋转 |
| `r/f` | 逆/顺时针旋转 + 自动拟合 |
| `g` | 反向（yaw + π） |
| `t` | 显示轨迹 |
| `v` | 主视图切换 resize/translate/rotate，或进/出 Batch Edit |
| `z/x/c` | 3D 编辑下切换 x/y/z 轴 |
| `1/2` | 上/下一个 box |
| `3/4` 或 `PageUp/PageDown` | 上/下一帧 |
| `Ctrl + S` | 保存 |
| `Del` 或 `Ctrl + D` | 删除选中 box |
| `Escape` | 取消选择/退出编辑 |

Batch Edit：

| 键 | 操作 |
|---|---|
| `Ctrl + A` | 全选 |
| `Ctrl + S` | 保存 |
| `3/4` | 上/下一批（或上/下一个 object） |
| `v` / `Escape` | 退出 batch 模式 |
| 右键菜单 | `s`=全选、`a`=Auto、`e`=Interpolate、`f`=Finalize、`d`=Delete、`g`=跳到该帧、`t`=显示轨迹 |

---

## 9. 一句话总结

**先在 3–5 个关键帧把每个物体的类别 / ID / 尺寸敲定 → 用 Batch Edit 的 Auto + Interpolate 把整个 clip 铺满 → Finalize 锁住 → `tools/check_labels.py` 验收。**

`auto_annotate` 用作"补种子"，`interpolate` 用作"主力传播"，人工用作"关键帧 + 修边"，这三层组合是当前工程里性价比最高的路径。
