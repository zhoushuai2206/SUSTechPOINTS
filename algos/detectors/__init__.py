"""
可插拔 3D 检测器：为半自动标注提供单帧候选框。

对外只暴露 get_detector() 一个入口，根据配置返回一个 BaseDetector 实例。

配置来源（按优先级从高到低）：
    1. 环境变量 SUSTECH_DETECTOR   —— 直接指定后端名，例如 "dummy" / "openpcdet"
    2. algos/detector_config.json  —— 项目级配置
    3. 默认值 "dummy"              —— 零依赖兜底

后端接入方式：新增一个模块，继承 BaseDetector 并在 REGISTRY 中登记。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .base import BaseDetector, Detection  # noqa: F401


_CFG_FILE = Path(__file__).resolve().parents[1] / "detector_config.json"


def _load_config() -> dict:
    if _CFG_FILE.is_file():
        try:
            with open(_CFG_FILE, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception as e:  # noqa: BLE001
            print(f"[detectors] 读取 {_CFG_FILE} 失败，使用默认配置：{e}")
    return {}


def _instantiate(name: str, cfg: dict) -> BaseDetector:
    name = (name or "dummy").lower()
    if name == "dummy":
        from .dummy import DummyDetector
        return DummyDetector(**cfg.get("dummy", {}))
    if name == "openpcdet":
        from .openpcdet_detector import OpenPCDetDetector
        return OpenPCDetDetector(**cfg.get("openpcdet", {}))
    raise ValueError(f"未知检测器后端: {name}")


_singleton: BaseDetector | None = None
_singleton_reason: str | None = None


def get_detector() -> BaseDetector:
    """返回全局单例检测器。加载失败会自动回退到 DummyDetector。"""
    global _singleton, _singleton_reason
    if _singleton is not None:
        return _singleton

    cfg = _load_config()
    backend = os.environ.get("SUSTECH_DETECTOR") or cfg.get("backend") or "dummy"

    try:
        _singleton = _instantiate(backend, cfg)
        _singleton_reason = None
        print(f"[detectors] 已加载检测器后端: {backend} ({_singleton.name})")
    except Exception as e:  # noqa: BLE001
        _singleton_reason = f"加载 {backend} 失败: {e}"
        print(f"[detectors] {_singleton_reason}，回退到 dummy")
        from .dummy import DummyDetector
        _singleton = DummyDetector()
    return _singleton


def detector_status() -> dict:
    d = get_detector()
    return {
        "backend": d.name,
        "available": d.available,
        "info": d.describe(),
        "load_fallback_reason": _singleton_reason,
    }
