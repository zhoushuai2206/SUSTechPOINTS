"""algos: 自动标注后端。

对外只暴露 pre_annotate（薄壳）与 pcd_io。当前后端是本地 ONNX 模型
（BEVFusion CCRS lidar-only PointPillars + CenterHead 0.2m 版本导出）。
"""

from . import pre_annotate  # noqa: F401
from . import pcd_io  # noqa: F401
