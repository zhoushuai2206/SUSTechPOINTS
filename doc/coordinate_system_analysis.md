# SUSTechPOINTS 标注坐标系统分析文档

## 1. 概述

SUSTechPOINTS 是一个基于 Web 的 3D 点云标注工具，用于自动驾驶场景的目标标注。本文档详细分析其坐标系统的定义、Box 表示方式、中心点选取、长宽高计算等核心内容。

## 2. 坐标系统架构

### 2.1 多坐标系设计

系统采用多层坐标系设计，主要包括：

1. **Lidar 坐标系（局部坐标系）**
   - 以激光雷达为原点的局部坐标系
   - 标注数据存储在此坐标系中
   - 是标注操作的基准坐标系

2. **UTM 坐标系（全局坐标系）**
   - 基于 GPS/IMU 的全局坐标系
   - 用于多帧之间的位置对齐
   - 支持 ego pose 变换

3. **Scene 坐标系（场景坐标系）**
   - WebGL 渲染使用的坐标系
   - 通过 coordinatesOffset 进行偏移
   - 用于可视化显示

### 2.2 坐标系转换关系

```
Lidar 坐标系 <---> UTM 坐标系 <---> Scene 坐标系
     ↑                                    ↑
     |                                    |
  标注存储                            WebGL渲染
```

**关键转换函数**（位于 `public/js/world.js`）：

- `lidarPosToScene(pos)`: Lidar → Scene
- `scenePosToLidar(pos)`: Scene → Lidar
- `lidarPosToUtm(pos)`: Lidar → UTM
- `lidarRotToScene(rotEuler)`: 旋转 Lidar → Scene
- `sceneRotToLidar(rotEuler)`: 旋转 Scene → Lidar

### 2.3 坐标偏移（coordinatesOffset）

为了避免浮点精度问题，系统使用 `coordinatesOffset` 对大坐标值进行偏移：

```javascript
// world.js line 219
this.coordinatesOffset = coordinatesOffset;

// 转换矩阵中应用偏移
let trans_utm_scene = new THREE.Matrix4().identity()
    .setPosition(this.coordinatesOffset[0], 
                 this.coordinatesOffset[1], 
                 this.coordinatesOffset[2]);
```

## 3. Box 表示方式

### 3.1 PSR 表示法（Position-Scale-Rotation）

系统采用 **PSR 格式** 存储 3D Bounding Box：

```javascript
{
    "psr": {
        "position": {"x": float, "y": float, "z": float},  // 中心点坐标
        "scale": {"x": float, "y": float, "z": float},     // 长宽高
        "rotation": {"x": float, "y": float, "z": float}   // 欧拉角（弧度）
    },
    "obj_type": string,      // 目标类型（如 "car", "pedestrian"）
    "obj_id": string,        // 跟踪 ID
    "obj_attr": object       // 目标属性
}
```

### 3.2 XYZ 顶点表示法（两种顶点顺序）

系统中存在 **两种不同的顶点顺序约定**，需要特别注意区分：

#### 顺序 A：内部 PSR→XYZ 转换（util.js / psr_to_xyz）

按照"先前面后后面"的方式排列，前 4 个点为前面（X+ 平面）：

```
顶点 0: (x,  y, -z)  // 前-左-下 (FLB)
顶点 1: (x, -y, -z)  // 前-右-下 (FRB)
顶点 2: (x, -y,  z)  // 前-右-上 (FRT)
顶点 3: (x,  y,  z)  // 前-左-上 (FLT)
顶点 4: (-x,  y, -z) // 后-左-下 (RLB)
顶点 5: (-x, -y, -z) // 后-右-下 (RRB)
顶点 6: (-x, -y,  z) // 后-右-上 (RRT)
顶点 7: (-x,  y,  z) // 后-左-上 (RLT)
```

注释中明确说明："the first 4 vertex is the front plane, so it knows box direction"。

#### 顺序 B：外部 XYZ→PSR 转换（world.js / python_xyz_to_psr）

兼容 SECOND/PointRcnn 输出格式，前 4 个点为底面（Z- 平面）：

```
底面（z 最小）：
  0: bottom-left-front  (BLF)
  1: bottom-right-front (BRF)
  2: bottom-right-back  (BRB)
  3: bottom-left-back   (BLB)

顶面（z 最大）：
  4: top-left-front  (TLF)
  5: top-right-front (TRF)
  6: top-right-back  (TRB)
  7: top-left-back   (TLB)
```

> ⚠️ 注意：`util.js` 中的 `xyz_to_psr` 函数与 `psr_to_xyz` 的顶点顺序**并不一一对应**，这两套顶点顺序约定在代码中并存，使用时需根据上下文区分。

### 3.3 Box 几何定义（局部坐标系）

**Box 局部坐标系**（`public/js/util.js` `psr_to_xyz()` line 80-90）：

```javascript
var local_coord = [
    x, y, -z, 1,    // 前-左-下
    x, -y, -z, 1,   // 前-右-下
    x, -y, z, 1,    // 前-右-上
    x, y, z, 1,     // 前-左-上
    
    -x, y, -z, 1,   // 后-左-下
    -x, -y, -z, 1,  // 后-右-下
    -x, -y, z, 1,   // 后-右-上
    -x, y, z, 1,    // 后-左-上
];
```

其中：
- `x = scale.x / 2`（前后方向半长）
- `y = scale.y / 2`（左右方向半宽）
- `z = scale.z / 2`（垂直方向半高）

**关键约定**：
- Box 的"前方"对应局部坐标系的 **X+** 方向
- Box 的"左侧"对应局部坐标系的 **Y+** 方向
- Box 的"上方"对应局部坐标系的 **Z+** 方向

## 4. 中心点选取

### 4.1 中心点计算

Box 的中心点是 **8 个顶点的几何中心**（质心）：

```javascript
// world.js line 115-123
var pos = {x:0, y:0, z:0};
for (var i=0; i<8; i++){
    pos.x += ann[i*3];
    pos.y += ann[i*3+1];
    pos.z += ann[i*3+2];
}
pos.x /= 8;
pos.y /= 8;
pos.z /= 8;
```

### 4.2 中心点在坐标系中的位置

- **Lidar 坐标系**：标注时的中心点位置
- **Scene 坐标系**：通过变换矩阵转换后的位置
- **显示位置**：UI 左上角显示的是 Lidar 坐标系中的位置

```
Box信息显示格式：
*(表示已更改未保存) 类别-ID |距离| x y z | 长宽高 | roll pitch yaw | 点数 |F:n
```

## 5. 长宽高计算

### 5.1 PSR 格式中的尺寸语义

在 PSR 格式中，`scale` 直接表示 box 在三个局部坐标轴方向上的**完整长度**（不是半长）：

| 字段 | 含义 | 局部坐标轴 |
|------|------|-----------|
| `scale.x` | 前后方向尺寸（车长） | X 轴方向 |
| `scale.y` | 左右方向尺寸（车宽） | Y 轴方向 |
| `scale.z` | 垂直方向尺寸（车高） | Z 轴方向 |

由 `psr_to_xyz` 函数可知：在 box 局部坐标系中，顶点坐标的范围是：
- X ∈ [-scale.x/2, +scale.x/2]
- Y ∈ [-scale.y/2, +scale.y/2]
- Z ∈ [-scale.z/2, +scale.z/2]

### 5.2 从顶点格式反算尺寸（xyz → psr）

`world.js` 的 `xyz_to_psr` 函数（用于解析外部 XYZ 格式标注，line 104-145）：

```javascript
var scale = {
    x: Math.sqrt((ann[0]-ann[3])*(ann[0]-ann[3]) + 
                 (ann[1]-ann[4])*(ann[1]-ann[4])),  // |v0 - v1| in XY plane
    y: Math.sqrt((ann[0]-ann[9])*(ann[0]-ann[9]) + 
                 (ann[1]-ann[10])*(ann[1]-ann[10])), // |v0 - v3| in XY plane
    z: ann[14] - ann[2],  // v4.z - v0.z
};
```

> 注意：这里的索引 `ann[3]`、`ann[9]`、`ann[14]` 都是**步长为 3** 的扁平数组索引（24 个数字），即：
> - `ann[3]` = 顶点 1 的 x；`ann[4]` = 顶点 1 的 y
> - `ann[9]` = 顶点 3 的 x；`ann[10]` = 顶点 3 的 y
> - `ann[14]` = 顶点 4 的 z；`ann[2]` = 顶点 0 的 z

**计算逻辑**：
1. **scale.x**：底面相邻两点（v0、v1）在 XY 平面的距离 → 边 0-1 的长度
2. **scale.y**：底面对角相邻两点（v0、v3）在 XY 平面的距离 → 边 0-3 的长度
3. **scale.z**：顶面与底面的 Z 坐标差 → 高度

该函数假定的顶点顺序（XY 平面投影）：
```
   0 ─── 1
   │     │
   3 ─── 2
   (底面 4 点 + 顶面 4 点 4-7 一一对应)
```

⚠️ 此函数计算的 scale.x/scale.y 哪个对应"车长"取决于**外部数据顶点摆放的顺序**，并非总等同于"车辆前进方向"。

### 5.3 坐标轴默认约定

PSR 格式默认采用自动驾驶领域常见约定（右手坐标系）：

- **X 轴**：车辆前进方向（长度方向）
- **Y 轴**：车辆左侧方向（宽度方向）
- **Z 轴**：垂直向上方向（高度方向）

Box 局部 X+ 方向即 box 朝向（前方），由 `psr_to_xyz` 中 "the first 4 vertex is the front plane" 注释佐证。

## 6. 旋转角度计算

### 6.1 欧拉角表示

系统使用欧拉角表示旋转：

```javascript
rotation: {
    x: roll,   // 绕 X 轴旋转（横滚角）
    y: pitch,  // 绕 Y 轴旋转（俯仰角）
    z: yaw     // 绕 Z 轴旋转（偏航角）
}
```

### 6.2 Yaw 角计算（最重要）

从顶点计算 yaw 角（`world.js` line 138）：

```javascript
var angle = Math.atan2(ann[4]+ann[7]-2*pos.y, 
                       ann[3]+ann[6]-2*pos.x);
```

**计算逻辑**：
1. 取前面两个底部顶点（顶点 1 和 2）的中点
2. 计算从中心点到该中点的向量
3. 使用 `atan2` 计算该向量与 X 轴的夹角

### 6.3 旋转矩阵

系统使用 **ZYX 欧拉角顺序** 构建旋转矩阵（`util.js` line 273-317）：

```javascript
function euler_angle_to_rotate_matrix(eu, tr, order="ZYX"){
    // 先绕 Z 轴，再绕 Y 轴，最后绕 X 轴
    let R = matmul2(matrices[order[2]], 
                    matmul2(matrices[order[1]], 
                            matrices[order[0]], 3), 3);
    // ...
}
```

## 7. Box 创建和编辑

### 7.1 Box 创建

**默认尺寸**（`annotation.js` line 282-284）：
```javascript
box.scale.x = 1.8;  // 长度（米）
box.scale.y = 4.5;  // 宽度（米）
box.scale.z = 1.5;  // 高度（米）
```

### 7.2 Box 几何结构

Box 使用 THREE.js 的 `LineSegments` 渲染（`annotation.js` line 228-293）：

- 12 条边线（顶面 4 条 + 底面 4 条 + 垂直 4 条）
- 1 条方向指示线（指向前方）
- 使用 `BufferGeometry` 存储顶点

### 7.3 自动调整功能

系统提供多种自动调整功能：

1. **自动旋转**：根据点云分布自动计算最佳朝向
2. **自动缩放**：根据包含的点云自动调整 box 大小
3. **自动平移**：将 box 中心对齐到点云质心

## 8. 坐标变换详解

### 8.1 Ego Pose 变换

当存在 ego pose 数据时（`world.js` line 273-357）：

```javascript
// 1. 计算 Lidar 到 Ego 的变换
let trans_lidar_ego = new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(0, 0, Math.PI, "ZYX"))
    .setPosition(0, 0, 0.4);

// 2. 计算 Ego 到 UTM 的变换
let trans_ego_utm = new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(thisRot.x, thisRot.y, thisRot.z, "ZXY"))
    .setPosition(posDelta.x, posDelta.y, posDelta.z);

// 3. 组合变换
this.trans_lidar_utm = new THREE.Matrix4()
    .multiplyMatrices(trans_ego_utm, trans_lidar_ego);

// 4. 应用场景偏移
this.trans_lidar_scene = new THREE.Matrix4()
    .multiplyMatrices(trans_utm_scene, this.trans_lidar_utm);
```

### 8.2 标注数据的全局坐标

保存时转换为全局坐标（`annotation.js` line 154-164）：

```javascript
this.ann_to_vector_global = function(box) {
    let posG = this.world.lidarPosToScene(box.position);
    let rotG = this.world.lidarRotToScene(box.rotation);
    
    return [
        posG.x - this.world.coordinatesOffset[0],
        posG.y - this.world.coordinatesOffset[1],
        posG.z - this.world.coordinatesOffset[2],
        rotG.x, rotG.y, rotG.z,
        box.scale.x, box.scale.y, box.scale.z,
    ];
};
```

## 9. 数据存储格式

### 9.1 JSON 格式（PSR）

标准存储格式（`data/scene_name/label/frame_id.json`）：

```json
[
    {
        "psr": {
            "position": {"x": 10.5, "y": -2.3, "z": 0.8},
            "scale": {"x": 4.5, "y": 1.8, "z": 1.5},
            "rotation": {"x": 0, "y": 0, "z": 1.57}
        },
        "obj_type": "car",
        "obj_id": "1",
        "obj_attr": {},
        "annotator": "human"
    }
]
```

### 9.2 TXT 格式（XYZ）

兼容格式（`data/scene_name/bbox.xyz/frame_id.bbox.txt`）：

```
x0 y0 z0 x1 y1 z1 x2 y2 z2 x3 y3 z3 x4 y4 z4 x5 y5 z5 x6 y6 z6 x7 y7 z7
```

每行 24 个浮点数，表示 8 个顶点的坐标。

## 10. 关键特性总结

### 10.1 Box 表示特点

1. **中心点表示**：使用几何中心，而非底面中心
2. **尺寸定义**：scale 表示完整的长宽高，而非半长半宽半高
3. **旋转顺序**：ZYX 欧拉角顺序
4. **坐标系**：右手坐标系，Z 轴向上

### 10.2 坐标系特点

1. **多层设计**：Lidar → UTM → Scene 三层坐标系
2. **偏移优化**：使用 coordinatesOffset 避免大数值精度问题
3. **变换矩阵**：使用 THREE.js Matrix4 进行坐标变换
4. **Ego Pose**：支持基于 GPS/IMU 的全局对齐

### 10.3 计算精度

- 使用双精度浮点数（JavaScript Number）
- 通过坐标偏移减少精度损失
- 旋转使用四元数中间表示避免万向锁

## 11. 代码位置索引

| 功能 | 文件路径 | 关键函数/行号 |
|------|---------|--------------|
| PSR 到顶点转换 | `public/js/util.js` | `psr_to_xyz()` line 55-95 |
| 顶点到 PSR 转换 | `public/js/util.js` | `xyz_to_psr()` line 99-135 |
| 坐标系转换 | `public/js/world.js` | line 360-451 |
| Box 创建 | `public/js/annotation.js` | `createCuboid()` line 295-317 |
| 旋转矩阵 | `public/js/util.js` | `euler_angle_to_rotate_matrix()` line 273-317 |
| 标注保存 | `public/js/annotation.js` | `toBoxAnnotations()` line 133-149 |
| XYZ 格式转换 | `public/js/world.js` | `python_xyz_to_psr()` line 83-102 |

## 12. 使用建议

### 12.1 标注时注意事项

1. **中心点位置**：确保 box 中心对齐目标物体的几何中心
2. **底面高度**：注意 Z 坐标应该使目标底部接近地面
3. **方向角度**：前方向应指向目标物体的前进方向
4. **尺寸精度**：使用自动调整功能提高标注精度

### 12.2 数据转换注意事项

1. **坐标系对齐**：确认源数据的坐标系定义
2. **旋转顺序**：注意欧拉角的旋转顺序（ZYX）
3. **单位统一**：确保长度单位为米，角度为弧度
4. **顶点顺序**：XYZ 格式需严格遵循顶点顺序约定

## 13. 参考资料

- THREE.js 文档：https://threejs.org/docs/
- 欧拉角与旋转矩阵：https://en.wikipedia.org/wiki/Euler_angles
- KITTI 数据集格式：http://www.cvlibs.net/datasets/kitti/
- SUSTechPOINTS 论文：IEEE IV 2020, DOI: 10.1109/IV47402.2020.9304562

---

**文档版本**: 1.0  
**生成日期**: 2026-05-15  
**维护者**: SUSTechPOINTS 开发团队
