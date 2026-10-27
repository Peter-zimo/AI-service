"""
配置管理（主流方式）
- python-dotenv 加载 .env（环境变量优先于 .env 文件）
- 标准 OpenAI 兼容变量：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
- 可选备用模型（主模型不可用时自动降级）：FALLBACK_*
- 统一配置源：后台保存的 ai-config.json（NODE_AI_CONFIG 指向）作为补充来源
- 向后兼容：旧 DEEPSEEK_API_KEY / ZHIPU_API_KEY 继续生效
- 热更新：每 30 秒检查 .env 文件 mtime，变化则重载（无需重启）
"""

import json
import os
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent
ENV_FILE = BASE_DIR / ".env"

# 加载 .env（默认不覆盖已存在的环境变量，即环境变量优先）
load_dotenv(ENV_FILE)

_PLACEHOLDER_KEYS = ("your_deepseek_api_key_here", "your_zhipu_api_key_here")


def _get(key: str, default: str = "") -> str:
    """读取配置：环境变量 > .env"""
    return os.environ.get(key, "").strip() or default


def _load_node_ai_config() -> dict:
    """读取 Node 端管理后台保存的 ai-config.json（统一配置源）"""
    p = os.environ.get("NODE_AI_CONFIG", "")
    if not p or not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _clean_key(k: str) -> str:
    return "" if (not k or k in _PLACEHOLDER_KEYS) else k


# ============ LLM 主配置（标准 OpenAI 兼容，当下主流） ============
LLM_PROVIDER = _get("LLM_PROVIDER", "deepseek")  # 仅用于日志/展示，可任意命名
LLM_BASE_URL = _get("LLM_BASE_URL", "")
LLM_API_KEY = _get("LLM_API_KEY", "")
LLM_MODEL = _get("LLM_MODEL", "")
LLM_TEMPERATURE = float(_get("LLM_TEMPERATURE", "0.7"))
LLM_TIMEOUT = int(_get("LLM_TIMEOUT", "60"))

# ============ 备用模型（可选，主模型不可用时降级） ============
FALLBACK_BASE_URL = _get("FALLBACK_BASE_URL", "")
FALLBACK_API_KEY = _get("FALLBACK_API_KEY", "")
FALLBACK_MODEL = _get("FALLBACK_MODEL", "")

# ============ 向后兼容 + 统一配置源（ai-config.json） ============
_node_cfg = _load_node_ai_config()
_node_llm = _node_cfg.get("llm") or {}
_node_fb = _node_cfg.get("fallback") or {}

# 1. 旧变量名兼容（DEEPSEEK_API_KEY / ZHIPU_API_KEY）
if not LLM_API_KEY:
    LLM_API_KEY = _get("DEEPSEEK_API_KEY", "")
if not FALLBACK_API_KEY:
    FALLBACK_API_KEY = _get("ZHIPU_API_KEY", "")

# 2. 后台保存的 ai-config.json（优先于旧变量名，低于 LLM_* 环境变量）
if not LLM_API_KEY or LLM_API_KEY in _PLACEHOLDER_KEYS:
    k = _clean_key(_node_llm.get("apiKey", ""))
    if k:
        LLM_API_KEY = k
        LLM_BASE_URL = LLM_BASE_URL or _node_llm.get("baseUrl", "")
        LLM_MODEL = LLM_MODEL or _node_llm.get("model", "")
        LLM_PROVIDER = _node_llm.get("provider") or LLM_PROVIDER
        try:
            LLM_TEMPERATURE = float(_node_llm.get("temperature", LLM_TEMPERATURE))
        except (TypeError, ValueError):
            pass
if not FALLBACK_API_KEY or FALLBACK_API_KEY in _PLACEHOLDER_KEYS:
    k = _clean_key(_node_fb.get("apiKey", ""))
    if k:
        FALLBACK_API_KEY = k
        FALLBACK_BASE_URL = FALLBACK_BASE_URL or _node_fb.get("baseUrl", "")
        FALLBACK_MODEL = FALLBACK_MODEL or _node_fb.get("model", "")

# 3. 默认 base_url/model（未配置时）
if not LLM_BASE_URL:
    LLM_BASE_URL = "https://api.deepseek.com/v1"
if not LLM_MODEL:
    LLM_MODEL = "deepseek-chat"
if FALLBACK_API_KEY and not FALLBACK_BASE_URL:
    FALLBACK_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
if FALLBACK_API_KEY and not FALLBACK_MODEL:
    FALLBACK_MODEL = "glm-4-flash"

# ============ Node 主服务地址（Agent 工具回调用） ============
NODE_API_BASE = _get("NODE_API_BASE", "http://localhost:3456")

# ============ 系统提示词 ============
DEFAULT_SYSTEM_PROMPT = "你是一个专业的共享单车客服助手，说话简洁专业，热情友好。"

# ============ 兼容结构（供旧调用方 load_config() 使用） ============
AI_CONFIG = {
    "deepseek": {  # 主模型
        "enabled": bool(LLM_API_KEY),
        "api_key": LLM_API_KEY,
        "model": LLM_MODEL,
        "base_url": LLM_BASE_URL,
        "provider": LLM_PROVIDER,
        "temperature": LLM_TEMPERATURE,
        "timeout": LLM_TIMEOUT,
    },
    "zhipu": {  # 备用模型（含 embedding API 来源）
        "enabled": bool(FALLBACK_API_KEY),
        "api_key": FALLBACK_API_KEY,
        "model": FALLBACK_MODEL,
        "base_url": FALLBACK_BASE_URL,
    },
    "default_provider": LLM_PROVIDER,
    "system_prompt": _get("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
}

# mtime 缓存，用于热更新检测
_last_mtime: float = 0.0
_last_load_time: float = 0.0
RELOAD_INTERVAL = 30  # 秒


def _reload_env() -> None:
    """重载 .env（不覆盖已存在的环境变量），并刷新模块级常量"""
    global LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, \
        LLM_TEMPERATURE, LLM_TIMEOUT, FALLBACK_BASE_URL, FALLBACK_API_KEY, FALLBACK_MODEL

    load_dotenv(ENV_FILE)
    LLM_PROVIDER = _get("LLM_PROVIDER", LLM_PROVIDER)
    LLM_BASE_URL = _get("LLM_BASE_URL", LLM_BASE_URL)
    LLM_API_KEY = _get("LLM_API_KEY", LLM_API_KEY)
    LLM_MODEL = _get("LLM_MODEL", LLM_MODEL)
    LLM_TEMPERATURE = float(_get("LLM_TEMPERATURE", str(LLM_TEMPERATURE)))
    LLM_TIMEOUT = int(_get("LLM_TIMEOUT", str(LLM_TIMEOUT)))
    FALLBACK_BASE_URL = _get("FALLBACK_BASE_URL", FALLBACK_BASE_URL)
    FALLBACK_API_KEY = _get("FALLBACK_API_KEY", FALLBACK_API_KEY)
    FALLBACK_MODEL = _get("FALLBACK_MODEL", FALLBACK_MODEL)

    # 若 LLM_* 未配置，尝试从后台保存的 ai-config.json 补充
    node_cfg = _load_node_ai_config()
    node_llm = node_cfg.get("llm") or {}
    node_fb = node_cfg.get("fallback") or {}
    if not LLM_API_KEY or LLM_API_KEY in _PLACEHOLDER_KEYS:
        k = _clean_key(node_llm.get("apiKey", ""))
        if k:
            LLM_API_KEY = k
            LLM_BASE_URL = LLM_BASE_URL or node_llm.get("baseUrl", "")
            LLM_MODEL = LLM_MODEL or node_llm.get("model", "")
    if not FALLBACK_API_KEY or FALLBACK_API_KEY in _PLACEHOLDER_KEYS:
        k = _clean_key(node_fb.get("apiKey", ""))
        if k:
            FALLBACK_API_KEY = k
            FALLBACK_BASE_URL = FALLBACK_BASE_URL or node_fb.get("baseUrl", "")
            FALLBACK_MODEL = FALLBACK_MODEL or node_fb.get("model", "")


def load_config(force: bool = False) -> dict:
    """
    加载配置（带 mtime 缓存，.env 变更后 30 秒内自动生效）
    返回: 兼容旧结构的 AI_CONFIG 字典
    """
    global _last_mtime, _last_load_time

    now = time.time()
    mtime = ENV_FILE.stat().st_mtime if ENV_FILE.exists() else 0

    if force or (now - _last_load_time) >= RELOAD_INTERVAL or mtime != _last_mtime:
        _reload_env()
        AI_CONFIG["deepseek"].update(
            enabled=bool(LLM_API_KEY), api_key=LLM_API_KEY, model=LLM_MODEL,
            base_url=LLM_BASE_URL, provider=LLM_PROVIDER,
            temperature=LLM_TEMPERATURE, timeout=LLM_TIMEOUT,
        )
        AI_CONFIG["zhipu"].update(
            enabled=bool(FALLBACK_API_KEY), api_key=FALLBACK_API_KEY,
            model=FALLBACK_MODEL, base_url=FALLBACK_BASE_URL,
        )
        AI_CONFIG["default_provider"] = LLM_PROVIDER
        AI_CONFIG["system_prompt"] = _get("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)
        _last_mtime = mtime
        _last_load_time = now

    return AI_CONFIG


def get_available_provider() -> Optional[str]:
    """返回当前可用的主模型提供商名（deepseek），主模型不可用但有备用时返回备用名（zhipu）"""
    cfg = load_config()
    if cfg["deepseek"]["enabled"] and cfg["deepseek"]["api_key"]:
        return "deepseek"
    if cfg["zhipu"]["enabled"] and cfg["zhipu"]["api_key"]:
        return "zhipu"
    return None


def get_provider_config(provider: str) -> dict:
    """获取指定提供商的实际配置（含 base_url / model / api_key / temperature）"""
    cfg = load_config()
    if provider == "deepseek" or provider == LLM_PROVIDER:
        return cfg["deepseek"]
    if provider == "zhipu":
        return cfg["zhipu"]
    return cfg.get(provider, {})
