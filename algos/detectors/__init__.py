"""
自动标注检测器：固定使用 OpenPCDet 的 CenterPoint 模型。

启动流程：
    1. 项目启动脚本会调用 setup_env.sh 自动安装 torch / spconv / OpenPCDet 并
       下载 CenterPoint 权重。
    2. 服务运行时读取 algos/detector_config.json，构造 OpenPCDetDetector 单例。
    3. 环境变量 SUSTECH_DETECTOR_CFG 可覆盖 config 路径（用于测试或多模型切换）。

设计约束：不再提供纯几何兜底后端。任何 CenterPoint 加载失败都会抛异常，让
运维/开发者第一时间感知，而不是静默降级到"能出框但没意义"的兜底。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .base import BaseDetector, Detection  # noqa: F401


_DEFAULT_CFG_FILE = Path(__file__).resolve().parents[1] / "detector_config.json"


def _load_config() -> dict:
    cfg_path = os.environ.get("SUSTECH_DETECTOR_CFG") or str(_DEFAULT_CFG_FILE)
    p = Path(cfg_path)
    if not p.is_file():
        raise FileNotFoundError(
            f"detector_config.json 缺失: {p}. 请检查项目根目录或设置 SUSTECH_DETECTOR_CFG。"
        )
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f) or {}


def _instantiate(cfg: dict) -> BaseDetector:
    backend = (cfg.get("backend") or "openpcdet").lower()
    if backend != "openpcdet":
        raise ValueError(
            f"当前工程仅支持 backend=openpcdet（CenterPoint）；收到: {backend}"
        )

    sub = cfg.get("openpcdet") or {}
    required = ("config_path", "ckpt_path")
    missing = [k for k in required if not sub.get(k)]
    if missing:
        raise ValueError(
            f"detector_config.json 的 openpcdet 段缺少字段: {missing}"
        )

    ckpt_path = sub.get("ckpt_path")
    if ckpt_path and not os.path.isfile(ckpt_path):
        raise FileNotFoundError(
            f"CenterPoint 权重不存在: {ckpt_path}. "
            "请运行 `bash setup_env.sh` 自动下载，或手动放置到该路径。"
        )
    config_path = sub.get("config_path")
    if config_path and not os.path.isfile(config_path):
        raise FileNotFoundError(
            f"OpenPCDet 配置不存在: {config_path}. "
            "请先运行 `bash setup_env.sh` 拉取 third_party/OpenPCDet。"
        )

    from .openpcdet_detector import OpenPCDetDetector
    return OpenPCDetDetector(**sub)


_singleton: BaseDetector | None = None
_singleton_reason: str | None = None


def get_detector() -> BaseDetector:
    """返回全局单例 CenterPoint 检测器；加载失败直接抛异常。"""
    global _singleton, _singleton_reason
    if _singleton is not None:
        return _singleton

    cfg = _load_config()
    _singleton = _instantiate(cfg)
    _singleton_reason = None
    print(f"[detectors] 已加载检测器后端: {_singleton.name}")
    return _singleton


def detector_status() -> dict:
    """状态接口用；出错时返回错误描述而不是抛出。"""
    try:
        d = get_detector()
        return {
            "backend": d.name,
            "available": d.available,
            "info": d.describe(),
            "load_error": None,
        }
    except Exception as e:  # noqa: BLE001
        return {
            "backend": "openpcdet",
            "available": False,
            "info": "CenterPoint 加载失败",
            "load_error": str(e),
        }
