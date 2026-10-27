"""
AI 对话模块
- 双模型支持（DeepSeek / 智谱）
- 流式输出（SSE）
- Agent 决策（Tool-calling）
- 对话历史管理
"""

from __future__ import annotations

import json
import threading
from typing import AsyncGenerator, Optional, List, Dict, Any, Callable
from datetime import datetime

import httpx

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from config import load_config, get_available_provider, get_provider_config, NODE_API_BASE
from knowledge.retriever import _get_kb, KnowledgeService, KnowledgeItem

# langchain_openai 会间接导入 transformers（装了 sentence-transformers 后约 25s），
# 因此改为懒加载 + 后台预热，避免拖慢 FastAPI 启动。
_llm_ready = threading.Event()


def _import_chat_openai():
    from langchain_openai import ChatOpenAI
    return ChatOpenAI


def preload_llm() -> None:
    """后台预热 langchain_openai，避免首个对话请求承担 20s+ 导入"""
    if _llm_ready.is_set():
        return

    def worker():
        try:
            _import_chat_openai()
            _llm_ready.set()
            print("[AI] LLM 模块预加载完成")
        except Exception as e:
            print(f"[AI] LLM 模块预加载失败: {e}")

    threading.Thread(target=worker, daemon=True).start()

# ============ 工具调用上下文（单次对话有效，传递 conv_id 等信息给工具函数）============
_tool_ctx: Dict[str, str] = {}

# ============ 全局实例 ============

_knowledge_service: Optional[KnowledgeService] = None


# ============ LLM 工厂 ============

def _create_llm(provider: Optional[str] = None, streaming: bool = True) -> Optional[ChatOpenAI]:
    """创建 LangChain ChatOpenAI 实例"""
    provider = provider or get_available_provider()
    if not provider:
        return None

    cfg = get_provider_config(provider)
    api_key = cfg.get("api_key", "")
    model = cfg.get("model", "deepseek-chat" if provider == "deepseek" else "glm-4-flash")
    base_url = cfg.get("base_url", "")

    if not api_key:
        return None

    ChatOpenAI = _import_chat_openai()
    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=base_url,
        streaming=streaming,
        temperature=cfg.get("temperature", 0.7),
        timeout=cfg.get("timeout", 60),
        max_tokens=2000,
    )


# ============ 会话历史管理 ============

class ConversationMemory:
    """对话历史管理（自动摘要，长对话不丢上下文）"""

    def __init__(self, max_history: int = 8, summary_after: int = 5):
        self._histories: Dict[str, List] = {}
        self.max_history = max_history
        self.summary_after = summary_after  # 每 N 轮自动摘要
        self._summary_cache: Dict[str, str] = {}  # conv_id -> summary text

    def add(self, conv_id: str, role: str, content: str) -> None:
        if conv_id not in self._histories:
            self._histories[conv_id] = []
        self._histories[conv_id].append({"role": role, "content": content})
        # 超出 max_history 时，检查是否需要生成摘要
        if len(self._histories[conv_id]) > self.max_history:
            # 保留最近 summary_after 条 + 摘要
            recent = self._histories[conv_id][-self.summary_after:]
            older = self._histories[conv_id][:-self.summary_after]
            # 异步生成摘要（不阻塞）
            summary_text = f"[历史摘要] 之前的对话经过了合并：共{len(older)}条消息"
            if older:
                summary_text = f"[历史摘要] 用户之前的关注点：{' '.join(m['content'][:50] for m in older[:3] if m['role']=='user')}"
            self._summary_cache[conv_id] = summary_text
            # 用摘要 + 最近消息替代全部
            self._histories[conv_id] = [
                {"role": "system", "content": f"【对话摘要】{summary_text}"}
            ] + recent

    def get(self, conv_id: str) -> List:
        return self._histories.get(conv_id, [])

    def clear(self, conv_id: str) -> None:
        self._histories.pop(conv_id, None)
        self._summary_cache.pop(conv_id, None)

    def to_langchain(self, conv_id: str) -> List:
        """转换为 LangChain 消息格式"""
        msgs = []
        for m in self.get(conv_id):
            if m["role"] == "system":
                msgs.append(SystemMessage(content=m["content"]))
            elif m["role"] == "user":
                msgs.append(HumanMessage(content=m["content"]))
            elif m["role"] == "assistant":
                msgs.append(AIMessage(content=m["content"]))
        return msgs


_memory = ConversationMemory()


# ============ 工具函数 ============

@tool
def search_knowledge_base(query: str) -> str:
    """
    搜索知识库，查找与用户问题相关的答案。
    当你发现用户的提问可能是常见问题时，调用此工具。
    """
    kb = _get_kb()
    results = kb.search(query)
    if not results:
        return "__EMPTY__"  # 标记空结果，让Agent自行判断
    # 返回最相关的前2条
    output = []
    for r in results[:2]:
        output.append(f"问题: {r['question']}\n答案: {r['answer']}\n相关度: {r['score']}")
    return "\n---\n".join(output)


@tool
def get_default_response(reason: str) -> str:
    """
    当无法回答用户问题时，生成合适的兜底回复。
    reason: 无法回答的原因（如"知识库无匹配"、"AI不可用"等）
    """
    return """抱歉，这个问题我暂时无法回答。可以尝试换个说法描述，或输入「转人工」联系真人客服。感谢您的理解！"""


@tool
def transfer_to_human(reason: str) -> str:
    """
    将用户转接到人工客服。
    reason: 转接原因（如"用户要求转人工"、"问题复杂"等）
    """
    return f"已接收到转人工请求，原因: {reason}。请通知用户：正在转接人工客服，请稍候..."


@tool
async def detect_user_emotion(text: str) -> str:
    """
    检测用户的情绪状态。
    如果用户情绪负面、愤怒或紧急，应当优先转接人工客服。
    """
    from ai.emotion import detect_emotion
    result = await detect_emotion(text)
    if result["needs_human"]:
        return f"用户情绪: {result['emotion']}({result['score']}分)。建议转人工。原因: {result['reason']}"
    return f"用户情绪: {result['emotion']}({result['score']}分)。可以正常处理。原因: {result['reason']}"


import random
from datetime import datetime, timedelta


@tool
def query_orders(phone: str = "") -> str:
    """
    查询用户的骑行记录和费用详情。
    当用户查询自己的骑行次数、消费金额、历史订单时调用此工具。
    phone: 用户手机号（必填，至少8位数字）
    """
    return "为保护个人隐私，在线客服不会通过聊天查询订单明细。请在已登录的 APP 订单中心查看，或由人工客服完成身份核验后协助处理。"


@tool
def query_nearby_parking(location: str = "") -> str:
    """
    查询指定位置附近的共享单车还车点/停车区。
    当用户询问附近停车点、还车点、P点、停车区时调用此工具。
    location: 位置描述，如"万达广场"、"中山路"等
    """
    spots = [
        {"name": "万达广场南门P点", "distance": "50米", "capacity": "充足"},
        {"name": "万达广场西门P点", "distance": "120米", "capacity": "较满（剩余3位）"},
        {"name": "地铁站B出口P点", "distance": "200米", "capacity": "充足"},
        {"name": "建设银行门口P点", "distance": "350米", "capacity": "充足"},
    ]
    if not location:
        location = "当前位置"
    output = [f"{location}附近的还车点："]
    for s in spots:
        output.append(f"  🅿 {s['name']} | 距离{s['distance']} | 车位{s['capacity']}")
    output.append("\n请在APP地图中查看实时停车位信息。")
    return "\n".join(output)


@tool
def check_promotions() -> str:
    """
    查询当前可用的优惠活动、折扣、骑行券等信息。
    当用户问有没有优惠、折扣、活动、骑行券、满减时调用此工具。
    """
    promos = [
        {"name": "新人专享", "desc": "新用户首单立减10元", "valid": "长期有效"},
        {"name": "周三会员日", "desc": "每周三骑行8折优惠", "valid": "每周三"},
        {"name": "月卡特惠", "desc": "30天不限次 ¥29.9（原价¥49）", "valid": "本月"},
        {"name": "邀请有礼", "desc": "邀请好友注册，双方各得¥5骑行券", "valid": "长期有效"},
    ]
    output = ["🎉 当前优惠活动："]
    for p in promos:
        output.append(f"  {p['name']}: {p['desc']}（{p['valid']}）")
    output.append('\n更多优惠请查看APP"我的"-"优惠中心"。')
    return "\n".join(output)


# ============ 写操作工具（框架——二次确认链路后续由前端对接）============

@tool
def submit_complaint(phone: str = "", order_id: str = "", reason: str = "") -> str:
    """
    为用户提交订单申诉/投诉。
    当用户因扣费异常、骑行时长计费争议、车辆故障扣费等需要申诉时调用。
    phone: 用户手机号
    order_id: 有争议的订单号
    reason: 申诉原因
    """
    if not phone or len(str(phone)) < 8:
        return "请先提供您的手机号，以便我们为您提交申诉。"
    if not order_id:
        return "请提供有问题的订单号，以便我们为您处理申诉。"
    if not reason or len(reason) < 5:
        return "请简要描述申诉原因（至少5个字），以便客服尽快处理。"
    return (
        f"[申诉已受理] 订单 {order_id} 的申诉已提交。"
        f"申诉原因：{reason}。"
        f"人工客服将在 1-3 个工作日内审核。"
        f"如需加急，可直接联系人工客服。"
    )


@tool
def request_refund(phone: str = "", order_id: str = "", reason: str = "") -> str:
    """
    为用户申请退款。
    当用户要求退款、退费、退还押金时调用。
    phone: 用户手机号
    order_id: 退款对应的订单号
    reason: 退款原因
    """
    if not phone or len(str(phone)) < 8:
        return "请先提供您的手机号，以便我们为您处理退款。"
    if not order_id:
        return "请提供需要退款的订单号。"
    if not reason or len(reason) < 5:
        return "请简要描述退款原因（至少5个字）。"
    return (
        f"[退款已受理] 订单 {order_id} 的退款申请已提交。"
        f"退款原因：{reason}。"
        f"审核通过后金额将在 1-3 个工作日内原路退回。"
    )


@tool
def request_manual_review(phone: str = "", issue: str = "") -> str:
    """
    为用户申请人工复核（扣费异议、账户异常等复杂问题）。
    当用户的问题无法通过常规问答解决、需要人工介入时调用。
    phone: 用户手机号
    issue: 具体问题描述
    """
    if not phone or len(str(phone)) < 8:
        return "请先提供您的手机号，以便我们为您转人工复核。"
    if not issue or len(issue) < 10:
        return "请详细描述您的问题（至少10个字），以便客服为您精准处理。"
    return (
        f"[人工复核已受理] 您的问题已转人工客服复核。"
        f"问题描述：{issue}。"
        f"客服将在工作日内与您联系处理。"
    )


# ============ AI 对话 ============

async def chat(
    conv_id: str,
    message: str,
    use_agent: bool = True,
) -> Dict[str, Any]:
    """
    AI 对话主入口
    - use_agent=True: 使用 Agent 决策（知识库优先 → AI 生成 → 兜底）
    - use_agent=False: 直接调用 LLM（不走 Agent）
    """
    cfg = load_config()
    provider = get_available_provider()

    # 保存用户消息
    _memory.add(conv_id, "user", message)

    if use_agent:
        return await _agent_chat(conv_id, message, provider)
    else:
        return await _direct_chat(conv_id, message, provider)


async def _direct_chat(conv_id: str, message: str, provider: Optional[str]) -> Dict[str, Any]:
    """直接调用 LLM（非 Agent 模式）"""
    cfg = load_config()
    llm = _create_llm(provider)

    if not llm:
        return {"type": "fallback", "answer": get_default_response.invoke({"reason": "AI不可用"})}

    # 知识库优先（置信门控 + 问题改写）
    kb = _get_kb()
    _llm_holder = {"llm": None}
    def _get_llm():
        if _llm_holder["llm"] is None:
            _llm_holder["llm"] = _create_llm(provider)
        return _llm_holder["llm"]
    best_match = await _smart_kb_match(kb, message, _get_llm)
    if best_match:
        _memory.add(conv_id, "assistant", best_match["answer"])
        return {
            "type": "knowledge",
            "answer": best_match["answer"],
            "confidence": min(best_match.get("score", 0) * 2, 1.0),
            "match_question": best_match.get("question"),
        }

    # 构建消息
    system = SystemMessage(content=cfg["system_prompt"])
    history = _memory.to_langchain(conv_id)
    user_msg = HumanMessage(content=message)
    # 【修复】history[:-1] 会丢掉刚加入的当前用户消息，必须补回 user_msg
    messages = [system] + history[:-1] + [user_msg]

    try:
        response = llm.invoke(messages)
        content = response.content
        _memory.add(conv_id, "assistant", content)
        return {"type": "ai", "answer": content, "confidence": 0.9, "provider": provider}
    except Exception as e:
        print(f"[AI] LLM 调用失败: {e}")
        # 尝试切换提供商（备用也失败时返回兜底，而非 500）
        fallback = "zhipu" if provider == "deepseek" else "deepseek"
        try:
            llm2 = _create_llm(fallback)
            if llm2:
                response = llm2.invoke(messages)
                content = response.content
                _memory.add(conv_id, "assistant", content)
                return {"type": "ai", "answer": content, "confidence": 0.9, "provider": fallback}
        except Exception as e2:
            print(f"[AI] 备用模型调用失败: {e2}")
        return {"type": "fallback", "answer": get_default_response.invoke({"reason": "所有AI均不可用"})}


async def _finalize_after_tool(messages: List, llm_with_tools) -> str:
    """循环耗尽且最后一条是工具结果时，追加一轮 LLM 收尾生成面向用户的回答。

    P0 修复：禁止把工具内部话术（如 transfer_to_human 的"请通知用户…"）
    直接作为最终答案发给用户。收尾失败或产出为空时，回退到轨迹中最近
    一次有内容的 AI 文本；仍无则退回工具结果兜底（保证不崩）。
    """
    try:
        resp = await llm_with_tools.ainvoke(messages)
        content = getattr(resp, "content", None)
        if content:
            return content
    except Exception as e:
        print(f"[Agent] 收尾总结失败: {e}")
    for m in reversed(messages):
        if isinstance(m, AIMessage) and m.content:
            return m.content
    return messages[-1].content


async def _agent_chat(conv_id: str, message: str, provider: Optional[str]) -> Dict[str, Any]:
    """Agent 模式（手动 ReAct 循环，不依赖 create_react_agent）"""
    cfg = load_config()
    llm = _create_llm(provider, streaming=False)

    if not llm:
        return {"type": "fallback", "answer": get_default_response.invoke({"reason": "AI不可用"})}

    # 可用工具列表（不包含 get_default_response，让 LLM 自行判断）
    all_tools = [
        search_knowledge_base, transfer_to_human,
        detect_user_emotion, query_orders, query_nearby_parking, check_promotions,
        submit_complaint, request_refund, request_manual_review
    ]
    tool_map = {t.name: t for t in all_tools}
    llm_with_tools = llm.bind_tools(all_tools)

    system_prompt = """你是共享单车品牌的AI客服助手，名字叫"小冲"。

回答原则：
1. 知识库优先：对于收费/开锁/故障/押金等业务问题，立即调用 search_knowledge_base
2. 灵活应对：如果知识库返回 __EMPTY__（无匹配），说明知识库没有收录该问题，此时可依据自己的知识尝试回答，或引导用户换个说法重新提问
3. 闲聊没问题：用户打招呼、闲聊、问非业务问题（如天气、日期、闲聊等），可以直接友好回复，不需调用任何工具
4. 需要转人工：用户情绪激动、问题复杂、或多次询问仍不满足时，调用 transfer_to_human
5. 禁止重复转述搜索结果：知识库有结果时直接给出答案，不要加"根据搜索结果"等前缀

强制规则（必须遵守）：
- 用户问优惠/折扣/活动 → 立即调用 check_promotions
- 用户问停车点/还车位置 → 立即调用 query_nearby_parking
- 用户问骑行记录/费用/订单 → 立即调用 query_orders（需要手机号）
- 用户要申诉/投诉扣费 → 立即调用 submit_complaint（需手机号+订单号+原因）
- 用户要退款/退费 → 立即调用 request_refund（需手机号+订单号+原因）
- 用户问题复杂或要求人工 → 调用 request_manual_review（需手机号+问题描述）
- 用户问常见问题（收费/开锁/故障/押金等）→ 立即调用 search_knowledge_base
- 以上规则优先级最高，严禁忽略工具直接回答
- 禁止问候开场，直接回答用户问题"""

    # 构造消息：注入对话历史（保留上下文），当前用户消息单独追加
    # 【修复】history[:-1] 剔除刚由 chat() 加入的当前 user 消息，避免重复
    force_directive = "\n[系统指令] 直接回答用户问题，不要问候。"
    history = _memory.to_langchain(conv_id)
    user_msg = HumanMessage(content=force_directive + "\n\n" + message)
    messages = [SystemMessage(content=system_prompt)] + history[:-1] + [user_msg]

    # 最多 3 轮 ReAct 循环
    max_rounds = 3
    for round_idx in range(max_rounds):
        response = await llm_with_tools.ainvoke(messages)

        if not response.tool_calls:
            # AI 直接回答（没有调用工具）
            final_answer = response.content
            _memory.add(conv_id, "assistant", final_answer)
            return {"type": "ai", "answer": final_answer, "confidence": 0.9, "provider": "agent"}

        # AI 调用了工具
        messages.append(response)
        for tc in response.tool_calls:
            tool_name = tc["name"]
            tool_args = tc.get("args", {})
            tool_fn = tool_map.get(tool_name)

            if not tool_fn:
                tool_result = f"错误: 未知工具 '{tool_name}'"
            else:
                try:
                    # 执行工具（async 工具必须用 ainvoke，sync 工具 ainvoke 同样可用）
                    result = await tool_fn.ainvoke(tool_args)
                    tool_result = result if isinstance(result, str) else str(result)
                except Exception as e:
                    tool_result = f"工具执行错误: {str(e)}"

            messages.append(ToolMessage(content=tool_result, tool_call_id=tc["id"]))

    # 最后一轮后取最终回答
    final = messages[-1]
    if isinstance(final, ToolMessage):
        # P0 修复：循环耗尽且最后一条是工具结果时，追加 LLM 收尾生成面向用户的回答，
        # 避免把工具内部话术原样发给用户
        final_answer = await _finalize_after_tool(messages, llm_with_tools)
    else:
        final_answer = final.content if hasattr(final, 'content') else str(final)

    _memory.add(conv_id, "assistant", final_answer)
    if "转人工" in final_answer or "转接" in final_answer:
        return {"type": "transfer", "answer": final_answer, "confidence": 1.0, "provider": "agent"}
    return {"type": "ai", "answer": final_answer, "confidence": 0.9, "provider": "agent"}


# ============ 流式输出 ============

def _match_confident(best: Optional[Dict]) -> bool:
    """知识库命中置信度判断：get_best_match 已按原始分做阈值，非 None 即高置信"""
    return best is not None


async def _smart_kb_match(kb, message: str, llm_factory: Callable) -> Optional[Dict]:
    """知识库匹配：置信门控（get_best_match 已按原始分做阈值）。

    注意：早期版本会用 LLM 改写后重新检索，导致无关查询被拉入知识库造成误报
    （如 '今天天气怎么样' → 改写 '今天天气如何' → 命中 '客服工作时间'）。
    改写路径已移除——get_best_match 未命中时交由 LLM 直接回答，避免误报。
    """
    best = kb.get_best_match(message)
    return best

async def chat_stream(
    conv_id: str,
    message: str,
    use_agent: bool = False,
) -> AsyncGenerator[str, None]:
    """
    流式 AI 对话（SSE）- 始终走实时 token 流
    use_agent: 仅影响非流式 chat() 的决策模式，流式不启用 Agent
    流程：知识库匹配 → LLM 实时流 → 完成
    """
    # P0-2 对齐：流式暂不支持 Agent 工具调用，请求方传 use_agent=True 时显式降级为直答并记录
    if use_agent:
        print(f"[流式] 收到 use_agent=True，但流式不支持 Agent 决策，已降级为直答模式 (conv={conv_id})")

    cfg = load_config()
    provider = get_available_provider()

    _memory.add(conv_id, "user", message)

    # 1. 知识库优先检查（置信门控 + 问题改写）
    kb = _get_kb()
    _llm_holder = {"llm": None}
    def _get_llm():
        if _llm_holder["llm"] is None:
            _llm_holder["llm"] = _create_llm(provider)
        return _llm_holder["llm"]
    best_match = await _smart_kb_match(kb, message, _get_llm)
    if best_match:
        _memory.add(conv_id, "assistant", best_match["answer"])
        yield json.dumps({"type": "knowledge", "content": best_match["answer"]})
        return

    # 2. LLM 实时流式生成
    llm = _create_llm(provider)
    if not llm:
        yield json.dumps({"type": "fallback", "content": get_default_response.invoke({"reason": "AI不可用"})["answer"]})
        return

    system = SystemMessage(content=cfg["system_prompt"])
    history = _memory.to_langchain(conv_id)
    user_msg = HumanMessage(content=message)
    # 【修复】history[:-1] 会丢掉刚加入的当前用户消息，必须补回 user_msg
    messages = [system] + history[:-1] + [user_msg]

    try:
        full_content = ""
        async for chunk in llm.astream(messages):
            token = chunk.content if hasattr(chunk, "content") else str(chunk)
            if token:
                full_content += token
                yield json.dumps({"type": "token", "content": token})
        _memory.add(conv_id, "assistant", full_content)
        yield json.dumps({"type": "end", "content": full_content, "source": "ai"})
    except Exception as e:
        print(f"[流式] 失败: {e}")
        # 切换提供商兜底（备用也失败时发送 error 事件，保证前端能区分结束）
        fallback = "zhipu" if provider == "deepseek" else "deepseek"
        try:
            llm2 = _create_llm(fallback)
            if llm2:
                full_content = ""
                async for chunk in llm2.astream(messages):
                    token = chunk.content if hasattr(chunk, "content") else str(chunk)
                    if token:
                        full_content += token
                        yield json.dumps({"type": "token", "content": token})
                _memory.add(conv_id, "assistant", full_content)
                yield json.dumps({"type": "end", "content": full_content, "source": "ai"})
            else:
                yield json.dumps({"type": "error", "content": "AI 服务不可用，请稍后重试"})
        except Exception as e2:
            print(f"[流式] 备用模型调用失败: {e2}")
            yield json.dumps({"type": "error", "content": "AI 服务暂不可用，请稍后重试"})


def get_conversation_history(conv_id: str) -> List:
    """获取对话历史"""
    return _memory.get(conv_id)


def clear_conversation(conv_id: str) -> None:
    """清除对话历史"""
    _memory.clear(conv_id)
