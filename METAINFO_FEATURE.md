# Meta Info Editor Feature

## 功能概述
在主界面左上角 "frame" 下拉菜单右侧增加了一个 "metainfo" 按钮，用于编辑选中 clip 的元数据信息。

## 使用方法

1. **打开编辑器**：
   - 在场景(scene)中选中一个 clip
   - 点击 frame 选择器右侧的 metainfo 按钮（文档图标）
   - 编辑界面将在屏幕中央以模态窗口形式显示

2. **编辑元数据**：
   - 所有字段均以下拉菜单方式进行选择编辑
   - 如果当前 clip 已有 meta_info.json 文件，会自动加载并显示当前值
   - 如果没有 meta_info.json 文件，会创建新文件，所有字段默认值为 "unknown"

3. **保存/取消**：
   - 点击 "Save" 按钮保存修改
   - 点击 "Cancel" 按钮或按 ESC 键取消编辑
   - 点击模态窗口外部区域也可关闭编辑器

4. **退出编辑模式**：
   - 再次点击 metainfo 按钮可退出编辑模式

## 文件结构

### 前端文件
1. **public/metainfo_config.json** - 配置文件，定义每个字段的可选值
   - 用户可以编辑此文件来自定义选项
   - 格式：每个字段对应一个值数组

2. **public/js/metainfo_editor.js** - MetaInfoEditor 类实现
   - 负责 UI 渲染、用户交互和数据持久化
   - 与后端 API 通信

3. **index.html** - 添加了 metainfo 按钮
   - 位于 frame-selector 之后
   - 使用 SVG 图标（文档样式）

4. **public/css/main.css** - 按钮样式定义

5. **public/js/editor.js** - 集成 MetaInfoEditor
   - 在编辑器初始化时创建 MetaInfoEditor 实例

### 后端文件
1. **main.py** - 添加 `/save_metainfo` 端点
   - 接收前端提交的元数据
   - 保存到 `data/<scene>/meta_info.json`

### 数据文件
- **data/<scene>/meta_info.json** - 每个 clip 的元数据存储
  - 一个 clip 对应一个文件
  - JSON 格式，键值对形式

## 配置文件示例

```json
{
  "label_version": ["unknown", "1.0.0", "1.1.0", "2.0.0"],
  "sensor": ["unknown", "lidar", "camera", "radar", "fusion"],
  "lidar": ["unknown", "robsense_helios_322", "velodyne_64", "velodyne_32"],
  "camera": ["unknown", "basler_ace", "hikvision_mv", "lucid_triton"],
  "city": ["unknown", "nanjing", "shanghai", "beijing"],
  "facility": ["unknown", "parking", "highway", "urban_road"],
  "status": ["unknown", "manual", "auto", "reviewed", "pending"]
}
```

## API 端点

### POST /save_metainfo
保存元数据到指定场景

**请求体**：
```json
{
  "scene": "single_frame/2026_07_20-16_29_16",
  "meta_info": {
    "label_version": "1.0.0",
    "sensor": "lidar",
    "lidar": "robsense_helios_322",
    "camera": "unknown",
    "city": "nanjing",
    "facility": "parking",
    "status": "manual"
  }
}
```

**响应**：
```json
{
  "status": "ok",
  "path": "./data/single_frame/2026_07_20-16_29_16/meta_info.json"
}
```

## 技术实现

### 前端
- 使用原生 JavaScript（ES6 模块）
- 响应式模态对话框
- 集成 globalKeyDownManager 处理键盘事件
- 使用 CSS 变量适配主题（深色/浅色模式）

### 后端
- CherryPy 框架
- JSON 格式数据存储
- 自动创建目录（如果不存在）
- 错误处理和状态码返回

## 注意事项

1. 修改 `public/metainfo_config.json` 后需要刷新浏览器页面
2. 确保 data/<scene> 目录有写权限
3. 所有字段值都是字符串类型
4. 按钮只在选中 clip 后才能使用
