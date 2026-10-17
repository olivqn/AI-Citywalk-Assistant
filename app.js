(() => {
    "use strict";

    const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
    const DEFAULT_CENTER = { lng: 121.445, lat: 31.205 };
    const PACE_LABELS = { relaxed: "轻松慢逛", normal: "正常节奏", packed: "紧凑多逛" };
    const core = window.CitywalkRouteCore;

    let map = null;
    let currentUserPoint = null;
    let currentStartName = "";
    let currentRoute = [];
    let currentRouteDistance = 0;
    let currentMetrics = null;
    let routeSnapshots = [];
    let initialSnapshot = null;
    let lastActionSummary = "";
    const walkingCache = new Map();
    const resolvedPlaces = new Map();
    let chatHistory = [];
    let tripState = {
        start: null,
        duration_minutes: null,
        theme: [],
        pace: null,
        end: null,
        constraints: [],
        max_walk_meters: null,
        required_places: [],
        excluded_places: [],
        required_categories: []
    };
    let selectedGpsSuggestion = null;
    let gpsDebounceTimer = null;
    let gpsSearchSeq = 0;
    let isBusy = false;
    let activeRequest = null;
    let activeProgress = null;
    let hasInteraction = false;
    let turnChatResponse = null;
    let executionIntent = null;
    let pendingTask = null;
    let discoveryPlaces = [];
    let discoveryQuery = null;
    let walkingGuide = null;
    let discoveryOverlays = [];
    let interactionVersion = 0;
    const serviceStatus = document.getElementById("service-status");

    function failureDescription(data) {
        const descriptions = {
            model_timeout: "本次 AI 回复超时", model_network_error: "本次 AI 请求遇到网络波动",
            empty_model_response: "本次 AI 服务返回了空回复",
            invalid_model_response: "本次 AI 返回格式异常", model_unavailable: "本次 AI 服务响应异常",
            model_rate_limited: "AI 请求暂时过多", missing_api_key: "尚未配置 AI 密钥",
            model_auth_error: "AI 密钥验证失败", model_quota_exceeded: "AI 账户额度不足",
            model_access_denied: "AI 访问被拒绝", model_not_found: "AI 模型配置有误",
            model_invalid_request: "AI 请求配置有误"
        };
        return descriptions[data?.fallback_reason || data?.failure_reason] || "本次 AI 请求未完成";
    }

    function responseStatus(data, stage = "chat") {
        if (stage === "chat") turnChatResponse = data;
        const chat = turnChatResponse || data;
        const local = chat.source === "rule_based" || chat.fallback_reason === "rule_based";
        let label = local ? "本轮本地处理" : chat.source === "model" ? "AI 已回复" : chat.source === "unavailable" ? "本轮 AI 未完成" : "本轮备用回复";
        let detail = local ? "这条明确指令由本地规则处理，没有发生 AI 断联。"
            : chat.source === "model" ? (chat.recovered ? "本次自动重试后已收到 AI 回复。" : "本次已收到 AI 回复。")
            : `${failureDescription(chat)}；下一条消息仍会重新尝试 AI。`;
        if (chat.source === "fallback" && !local) {
            const persistent = { missing_api_key: "AI 未配置", model_auth_error: "AI 验证失败", model_quota_exceeded: "AI 额度不足" };
            label = persistent[chat.fallback_reason] || label;
        }
        if (stage === "filter" && data.source !== "model") {
            label += " · 基础筛选";
            detail += ` 地点筛选使用基础规则：${failureDescription(data)}，不代表对话 AI 已断开。`;
        }
        serviceStatus.textContent = label;
        serviceStatus.title = detail;
    }

    async function requestJson(path, options = {}, timeout = 25000) {
        const controller = new AbortController();
        const cancelActive = () => controller.abort();
        const taskSignal = activeRequest?.signal;
        taskSignal?.addEventListener("abort", cancelActive, { once: true });
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            if (taskSignal?.aborted) throw new Error("已取消");
            const response = await fetch(apiUrl(path), { ...options, signal: controller.signal });
            if (!response.ok) throw new Error(`服务响应异常 (${response.status})`);
            return await response.json();
        } finally {
            clearTimeout(timer);
            taskSignal?.removeEventListener("abort", cancelActive);
        }
    }

    function waitForMap(promise) {
        const signal = activeRequest?.signal;
        if (!signal) return promise;
        return new Promise((resolve, reject) => {
            const cancel = () => reject(new DOMException("已取消", "AbortError"));
            if (signal.aborted) { cancel(); return; }
            signal.addEventListener("abort", cancel, { once: true });
            promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
        });
    }

    async function checkService() {
        try {
            const health = await requestJson("/api/health", {}, 4000);
            if (health.intent_endpoint !== "/api/intent" || health.restart_required) {
                serviceStatus.textContent = "服务需要重启";
                appendMessage("assistant", "当前服务没有加载最新代码。请重新运行“启动 Demo.cmd”并重启服务，再刷新本页。", "error");
                return;
            }
            if (!hasInteraction) serviceStatus.textContent = health.ai_configured ? "服务已就绪" : "AI 未配置";
        } catch (_) {
            if (hasInteraction) return;
            serviceStatus.textContent = "服务未连接";
            appendMessage("assistant", "还没有连上本地服务。请双击项目中的“启动 Demo.cmd”，然后打开 http://127.0.0.1:8000。", "error");
        }
    }

    function loadMap() {
        window.citywalkMapReady = () => {
            try { initMap(); } catch (_) {
                routeList.textContent = "地图加载失败，聊天仍可使用";
            }
        };
        const script = document.createElement("script");
        script.src = "https://api.map.baidu.com/api?v=1.0&type=webgl&ak=XS8HdzSDKpKJG7uGCsyuoJ6xCcxSrMwv&callback=citywalkMapReady";
        script.onerror = () => { routeList.textContent = "地图网络不可用，聊天仍可使用"; };
        document.head.appendChild(script);
    }

    const gpsInput = document.getElementById("gps-input");
    const gpsSuggestions = document.getElementById("gps-suggestions");
    const setStartButton = document.getElementById("set-start-btn");
    const routeList = document.getElementById("route-list");
    const routeSummary = document.getElementById("route-summary");
    const aiContext = document.getElementById("ai-context");
    const contextChips = document.getElementById("context-chips");
    const aiInterpretation = document.getElementById("ai-interpretation");
    const chatMessages = document.getElementById("chat-messages");
    const chatInput = document.getElementById("chat-input");
    const sendButton = document.getElementById("send-btn");
    const undoButton = document.getElementById("undo-route-btn");
    const appRoot = document.getElementById("app");
    const routePanel = document.getElementById("panel");
    const panelToggle = document.getElementById("panel-toggle");
    const mobileMapTab = document.getElementById("mobile-map-tab");
    const mobileChatTab = document.getElementById("mobile-chat-tab");

    function isMobileLayout() { return Boolean(window.matchMedia?.("(max-width: 640px), (max-width: 950px) and (max-height: 500px)")?.matches); }

    function setPanelExpanded(expanded) {
        if (!expanded) hideGpsSuggestions();
        routePanel.dataset.expanded = String(expanded);
        panelToggle?.setAttribute("aria-expanded", String(expanded));
        if (panelToggle) panelToggle.textContent = expanded ? "收起详情" : "展开详情";
    }

    function setMobileView(view) {
        if (view === "chat") hideGpsSuggestions();
        appRoot.dataset.mobileView = view;
        mobileMapTab?.setAttribute("aria-pressed", String(view === "map"));
        mobileChatTab?.setAttribute("aria-pressed", String(view === "chat"));
        if (view === "map" && isMobileLayout()) {
            chatInput.blur?.();
            window.requestAnimationFrame?.(() => {
                if (!map) return;
                map.checkResize?.();
                if (currentRoute.length || discoveryPlaces.length || walkingGuide) paintRoute(currentRoute, currentMetrics);
                else map.centerAndZoom(currentUserPoint || new BMapGL.Point(DEFAULT_CENTER.lng, DEFAULT_CENTER.lat), 15);
            });
        }
    }

    function syncViewportHeight() {
        const viewport = window.visualViewport;
        if (viewport && viewport.scale === 1 && viewport.height > 0) {
            appRoot.style.setProperty("--app-height", `${viewport.height}px`);
        }
    }

    class RouteError extends Error {}

    function captureSnapshot() {
        return { route: currentRoute.map(stop => ({ ...stop })), state: JSON.parse(JSON.stringify(tripState)),
            point: currentUserPoint, name: currentStartName, distance: currentRouteDistance, metrics: currentMetrics };
    }

    function restoreSnapshot(snapshot, render = true) {
        walkingGuide = null;
        currentRoute = snapshot.route.map(stop => ({ ...stop }));
        tripState = JSON.parse(JSON.stringify(snapshot.state));
        currentUserPoint = snapshot.point;
        currentStartName = snapshot.name;
        currentRouteDistance = snapshot.distance;
        currentMetrics = snapshot.metrics;
        gpsInput.value = currentStartName;
        if (render) {
            paintRoute(currentRoute, currentMetrics);
            renderRoute(currentRoute, currentRouteDistance);
            renderUnderstanding({ interpretation: currentRoute.length > 1 ? "以下为已生效路线。" : "请告诉我起点、时长和主题。" });
        }
    }

    function apiUrl(path) {
        return `${API_BASE}${path}`;
    }

    function initMap() {
        if (!window.BMapGL) {
            routeList.textContent = "地图暂时没有加载成功，请检查网络后刷新";
            appendMessage("assistant", "地图服务暂时没有加载成功。聊天仍可使用，刷新页面后可以重试地图。", "error");
            return;
        }

        map = new BMapGL.Map("container");
        map.centerAndZoom(new BMapGL.Point(DEFAULT_CENTER.lng, DEFAULT_CENTER.lat), 15);
        map.enableScrollWheelZoom(true);
        map.addEventListener?.("resize", () => {
            window.requestAnimationFrame?.(() => {
                if (isMobileLayout() && appRoot.dataset.mobileView !== "map") return;
                if (currentRoute.length || discoveryPlaces.length || walkingGuide) paintRoute(currentRoute, currentMetrics);
            });
        });
        try {
            map.setMapStyleV2({ styleId: "6b0a5e0b2bef73dabbbb2b6b5c2b0341" });
        } catch (_) {
            // 自定义地图样式不可用时继续使用默认样式。
        }
    }

    function createMessageShell(role) {
        const row = document.createElement("div");
        row.className = `msg ${role}`;

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.textContent = role === "assistant" ? "徐" : "我";

        const bubble = document.createElement("div");
        bubble.className = "bubble";

        row.append(avatar, bubble);
        chatMessages.appendChild(row);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return { row, bubble };
    }

    function appendMessage(role, content, variant = "") {
        const { row, bubble } = createMessageShell(role);
        if (variant) row.dataset.variant = variant;
        bubble.textContent = content || "";
        bubble.style.whiteSpace = "pre-wrap";
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return row;
    }

    function appendPlanningProgress() {
        const { row, bubble } = createMessageShell("assistant");
        const progress = document.createElement("div");
        progress.className = "ai-progress";
        const labels = ["理解你的需求", "搜索附近地点", "AI 筛选与匹配", "排列步行路线"];
        const nodes = labels.map(label => {
            const node = document.createElement("div");
            node.className = "ai-progress-step";
            node.textContent = `○ ${label}`;
            progress.appendChild(node);
            return node;
        });
        bubble.appendChild(progress);

        return {
            row,
            setStage(index, detail = "") {
                nodes.forEach((node, nodeIndex) => {
                    node.classList.toggle("done", nodeIndex < index);
                    node.classList.toggle("active", nodeIndex === index);
                    const mark = nodeIndex < index ? "✓" : nodeIndex === index ? "●" : "○";
                    node.textContent = `${mark} ${labels[nodeIndex]}${nodeIndex === index && detail ? ` · ${detail}` : ""}`;
                });
                chatMessages.scrollTop = chatMessages.scrollHeight;
            },
            complete() {
                nodes.forEach((node, nodeIndex) => {
                    node.classList.remove("active");
                    node.classList.add("done");
                    node.textContent = `✓ ${labels[nodeIndex]}`;
                });
            },
            fail(message) {
                nodes.forEach(node => node.classList.remove("active"));
                const note = document.createElement("div");
                note.className = "theme-note";
                note.textContent = message;
                progress.appendChild(note);
            }
        };
    }

    function setBusy(value) {
        isBusy = value;
        setStartButton.disabled = value;
        sendButton.disabled = false;
        sendButton.setAttribute("aria-label", value ? "停止等待" : "发送");
        sendButton.title = value ? "停止等待" : "发送";
        sendButton.setAttribute("aria-busy", String(value));
        chatInput.placeholder = value ? "正在处理，可点击右侧方块停止等待" : "找地点、问故事、改路线，或找附近卫生间";
        document.querySelectorAll(".quick-prompt").forEach(button => { button.disabled = value; });
        if (undoButton) undoButton.disabled = value || !routeSnapshots.length;
        if (mobileChatTab) mobileChatTab.textContent = value ? "对话 · 处理中" : "对话";
    }

    function renderUnderstanding(data) {
        if (data.trip_state) {
            tripState = {
                ...tripState,
                ...data.trip_state,
                theme: Array.isArray(data.trip_state.theme) ? data.trip_state.theme : tripState.theme,
                constraints: Array.isArray(data.trip_state.constraints) ? data.trip_state.constraints : tripState.constraints
            };
        }

        if (currentStartName && !tripState.start) tripState.start = currentStartName;

        const chips = [];
        if (tripState.start) chips.push(`起点 · ${tripState.start}`);
        if (tripState.duration_minutes) chips.push(`目标时长 · ${formatDuration(tripState.duration_minutes)}`);
        if (tripState.theme?.length) chips.push(`主题 · ${tripState.theme.join(" / ")}`);
        if (tripState.pace) chips.push(`节奏 · ${PACE_LABELS[tripState.pace] || tripState.pace}`);
        if (tripState.end) chips.push(`终点 · ${tripState.end}`);
        if (tripState.max_walk_meters) chips.push(`步行 · ${tripState.max_walk_inclusive === false ? "<" : "≤"} ${tripState.max_walk_meters} 米`);
        if (tripState.min_stops != null) chips.push(`景点 · 至少 ${tripState.min_stops} 处`);
        if (tripState.max_stops != null) chips.push(`景点 · 最多 ${tripState.max_stops} 处`);
        if (tripState.required_categories?.length) chips.push(`必须有 · ${tripState.required_categories.join(" / ")}`);
        if (tripState.excluded_places?.length) chips.push(`不去 · ${tripState.excluded_places.join(" / ")}`);

        contextChips.replaceChildren();
        chips.forEach(text => {
            const chip = document.createElement("span");
            chip.className = "context-chip";
            chip.textContent = text;
            contextChips.appendChild(chip);
        });

        aiInterpretation.textContent = data.interpretation || "";
        aiContext.classList.toggle("visible", chips.length > 0 || Boolean(data.interpretation));
    }

    function formatDuration(minutes) {
        if (!minutes) return "未设置";
        if (minutes < 60) return `${minutes} 分钟`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }

    function showGpsSuggestionMessage(message) {
        gpsSuggestions.replaceChildren();
        const item = document.createElement("div");
        item.className = "gps-suggestion-empty";
        item.textContent = message;
        gpsSuggestions.appendChild(item);
        gpsSuggestions.style.display = "block";
    }

    function cancelGpsSearch() {
        clearTimeout(gpsDebounceTimer);
        gpsDebounceTimer = null;
        gpsSearchSeq += 1;
    }

    function hideGpsSuggestions() {
        cancelGpsSearch();
        gpsSuggestions.style.display = "none";
        gpsSuggestions.replaceChildren();
    }

    function formatPoiAddress(poi) {
        return [poi.province, poi.city, poi.address]
            .filter(Boolean)
            .map(part => String(part).trim())
            .filter(Boolean)
            .join(" ") || "暂无详细地址";
    }

    function renderGpsSuggestions(pois) {
        if (isMobileLayout()) {
            if (appRoot.dataset.mobileView !== "map") return;
            setPanelExpanded(true);
        }
        gpsSuggestions.replaceChildren();
        if (!pois.length) {
            showGpsSuggestionMessage("没有找到匹配地点，请输入更具体的地标");
            return;
        }

        pois.forEach(poi => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gps-suggestion";
            const name = document.createElement("span");
            name.className = "poi-name";
            name.textContent = poi.title;
            const address = document.createElement("span");
            address.className = "poi-address";
            address.textContent = formatPoiAddress(poi);
            button.append(name, address);
            button.addEventListener("mousedown", event => event.preventDefault());
            button.addEventListener("click", () => {
                selectedGpsSuggestion = poi;
                setStartPoint(poi.point, poi.title, formatPoiAddress(poi));
                hideGpsSuggestions();
            });
            gpsSuggestions.appendChild(button);
        });
        gpsSuggestions.style.display = "block";
    }

    function requestGpsSuggestions(keyword) {
        const query = keyword.trim();
        selectedGpsSuggestion = null;
        if (!query || !map) {
            hideGpsSuggestions();
            return;
        }

        const seq = ++gpsSearchSeq;
        showGpsSuggestionMessage("正在搜索候选地点…");
        const local = new BMapGL.LocalSearch("上海市", {
            pageCapacity: 8,
            onSearchComplete(result) {
                if (seq !== gpsSearchSeq) return;
                const pois = [];
                if (local.getStatus() === BMAP_STATUS_SUCCESS && result) {
                    for (let i = 0; i < result.getCurrentNumPois(); i += 1) {
                        const poi = result.getPoi(i);
                        if (poi?.title && core.inDemoArea(poi?.point)) pois.push(poi);
                    }
                }
                renderGpsSuggestions(pois);
            }
        });
        local.search(query);
    }

    function geocodeAddress(address) {
        // Never accept a fuzzy geocode silently: verify named POIs in the demo area.
        return new Promise(resolve => {
            if (!map || !address) return resolve(null);
            const timeout = setTimeout(() => resolve(null), 8000);
            if (!BMapGL.LocalSearch) { clearTimeout(timeout); return resolve(null); }
            const anchors = { 衡山路: "衡山路地铁站", 徐家汇: "徐家汇地铁站" };
            const query = anchors[core.normalizeName(address)] || address;
            const search = new BMapGL.LocalSearch("上海市", {
                pageCapacity: 10,
                onSearchComplete(result) {
                    clearTimeout(timeout);
                    const candidates = [];
                    if (search.getStatus() === BMAP_STATUS_SUCCESS && result) {
                        for (let i = 0; i < result.getCurrentNumPois(); i += 1) {
                            const poi = result.getPoi(i);
                            const baseTitle = poi?.title?.replace(/[（(].*?[）)]/g, "") || "";
                            const stationMatch = query.endsWith("地铁站") && /地铁/.test(poi?.address || "")
                                && core.normalizeName(poi.title) === core.normalizeName(query.replace(/地铁站$/, ""));
                            if (core.inDemoArea(poi?.point) && (stationMatch || core.samePlace(poi.title, query)
                                || core.normalizeName(baseTitle) === core.normalizeName(query))) candidates.push(poi);
                        }
                    }
                    const stations = candidates.filter(poi => query.endsWith("地铁站") && /地铁/.test(poi.address || "")
                        && core.normalizeName(poi.title) === core.normalizeName(query.replace(/地铁站$/, "")));
                    const exact = stations.length ? stations : candidates.filter(poi => core.normalizeName(poi.title) === core.normalizeName(query));
                    const matches = exact.length ? exact : candidates;
                    // Nearby subway exits are one location; branches far apart need a choice.
                    if (matches.length && matches.every(poi => haversineDistance(matches[0].point, poi.point) < 250)) {
                        resolvedPlaces.set(address, matches[0]);
                        resolve(matches[0].point);
                    } else {
                        if (matches.length) renderGpsSuggestions(matches);
                        resolve(null);
                    }
                }
            });
            search.search(query);
        });
    }

    function addStartMarker() {
        if (!map || !currentUserPoint) return;
        const marker = new BMapGL.Marker(currentUserPoint);
        // Keep the origin to the left on phones; stop numbers sit to the right.
        const label = new BMapGL.Label("起点", { offset: new BMapGL.Size(isMobileLayout() ? -50 : 15, -18) });
        label.setStyle({
            color: "#0a1628",
            backgroundColor: "#4facfe",
            border: "none",
            borderRadius: "5px",
            padding: "4px 8px",
            fontSize: "12px"
        });
        marker.setLabel(label);
        map.addOverlay(marker);
    }

    async function setStartPoint(point, name, detailAddress = "") {
        if (!point || !map || isBusy || !core.inDemoArea(point)) return false;
        const before = captureSnapshot();
        currentUserPoint = point;
        currentStartName = name;
        selectedGpsSuggestion = selectedGpsSuggestion?.title === name ? selectedGpsSuggestion : null;
        gpsInput.value = name;
        tripState.start = name;

        if (currentRoute.length > 1) {
            setBusy(true);
            try {
                await publishRoute([{ name, point, isStart: true, detailAddress }, ...currentRoute.slice(1)], false);
                routeSnapshots.push(before);
                appendMessage("assistant", `起点已改为${name}，其他地点保持不变。`);
            } catch (error) {
                restoreSnapshot(before);
                appendMessage("assistant", `没有更改起点：${error.message}。原路线保留。`);
            } finally { setBusy(false); }
        } else {
            map.clearOverlays();
            addStartMarker();
            map.panTo(point);
            routeList.replaceChildren();
            const item = document.createElement("li");
            item.className = "start-point";
            item.textContent = `📍 起点：${name}${detailAddress && detailAddress !== "暂无详细地址" ? `｜${detailAddress}` : ""}`;
            routeList.appendChild(item);
            routeSummary.classList.remove("visible");
        }
        renderUnderstanding({ trip_state: tripState, interpretation: "起点已确认，可以直接告诉我想怎么逛。" });
        return true;
    }

    async function setStartFromInput() {
        if (isBusy) return;
        const version = ++interactionVersion;
        const address = gpsInput.value.trim();
        if (!address) {
            appendMessage("assistant", "请先输入一个具体起点，例如“上海图书馆”。");
            return;
        }
        if (selectedGpsSuggestion?.title === address) {
            await setStartPoint(selectedGpsSuggestion.point, selectedGpsSuggestion.title, formatPoiAddress(selectedGpsSuggestion));
            return;
        }
        hideGpsSuggestions();
        setStartButton.disabled = true;
        const point = await geocodeAddress(address);
        setStartButton.disabled = false;
        if (version !== interactionVersion || isBusy) return;
        if (!point) {
            appendMessage("assistant", `我还没找到“${address}”，试试输入更具体的上海地标。`);
            return;
        }
        await setStartPoint(point, address);
    }

    async function ensureStartPoint() {
        const proposedStart = tripState.start || gpsInput.value.trim();
        if (currentUserPoint && proposedStart === currentStartName && core.inDemoArea(currentUserPoint)) return true;
        if (!proposedStart) {
            if (isMobileLayout()) setMobileView("chat");
            appendMessage("assistant", "还差一个起点。你可以直接说“从上海图书馆出发”，或者在地图左上角设置起点。", "needs-input");
            return false;
        }
        const point = await waitForMap(geocodeAddress(proposedStart));
        if (!point) {
            throw new RouteError(`未能唯一确认“${proposedStart}”在徐汇 Demo 覆盖范围内的位置。请在左上角搜索并选择带地址的候选地点`);
        }
        currentUserPoint = point;
        currentStartName = proposedStart;
        return true;
    }

    function haversineDistance(p1, p2) {
        const R = 6371000;
        const toRad = value => value * Math.PI / 180;
        const dLat = toRad(p2.lat - p1.lat);
        const dLng = toRad(p2.lng - p1.lng);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat))
            * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function searchOneKeyword(keyword, radius, center = currentUserPoint, facilities = false) {
        return new Promise(resolve => {
            if (!map || !center) return resolve([]);
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const local = new BMapGL.LocalSearch(map, {
                pageCapacity: 10,
                onSearchComplete(result) {
                    const found = [];
                    if (local.getStatus() === BMAP_STATUS_SUCCESS && result) {
                        for (let i = 0; i < result.getCurrentNumPois(); i += 1) {
                            const poi = result.getPoi(i);
                            if (poi?.point && poi?.title && (facilities ? core.inDemoArea(poi.point) : core.isUsablePoi(poi))
                                && haversineDistance(center, poi.point) <= radius) {
                                found.push({
                                    name: poi.title,
                                    point: poi.point,
                                    address: formatPoiAddress(poi),
                                    tags: poi.tags,
                                    category: poi.category,
                                    categories: poi.categories,
                                    type: poi.type,
                                    keyword
                                });
                            }
                        }
                    }
                    finish(found);
                }
            });
            local.searchNearby(keyword, center, radius);
            window.setTimeout(() => finish([]), 9000);
        });
    }

    function resolveCatalogPlace(entry, radius, center = currentUserPoint) {
        return new Promise(resolve => {
            if (!map || !center) return resolve(null);
            let settled = false;
            const finish = value => { if (!settled) { settled = true; resolve(value); } };
            const timer = setTimeout(() => finish(null), 6500);
            const search = new BMapGL.LocalSearch("上海市", {
                pageCapacity: 10,
                onSearchComplete(result) {
                    clearTimeout(timer);
                    const matches = [];
                    if (search.getStatus() === BMAP_STATUS_SUCCESS && result) {
                        for (let index = 0; index < result.getCurrentNumPois(); index += 1) {
                            const poi = result.getPoi(index);
                            if (core.matchesCatalogPlace(poi, entry) && core.isUsablePoi(poi)
                                && haversineDistance(center, poi.point) <= radius) matches.push(poi);
                        }
                    }
                    if (!matches.length || matches.some(poi => haversineDistance(matches[0].point, poi.point) > 150)) return finish(null);
                    const poi = matches[0];
                    finish({ name: poi.title, point: poi.point, address: formatPoiAddress(poi),
                        tags: entry.tags, catalog: entry, keyword: "地点库" });
                }
            });
            search.search(entry.name);
        });
    }

    async function searchCatalog(keywords, radius, originalMessage, progress) {
        try {
            const query = [...keywords, ...(tripState.theme || []), originalMessage].filter(Boolean).join(" ");
            const data = await requestJson(`/api/places/search?query=${encodeURIComponent(query)}&limit=8`, {}, 4000);
            const entries = Array.isArray(data.places) ? data.places.slice(0, 8) : [];
            if (!entries.length) return [];
            progress.setStage(1, `地点库命中 ${entries.length} 个，正在地图核对名称和地址`);
            const found = await waitForMap(Promise.all(entries.map(entry => resolveCatalogPlace(entry, radius))));
            return found.filter(Boolean).map(poi => ({ ...poi,
                keyword: keywords.find(keyword => core.categoryMatches(poi, keyword)) || keywords[0] || "地点库" }));
        } catch (_) {
            if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
            // Catalog retrieval is local, and must never change the AI connection label.
            return [];
        }
    }

    async function searchPois(keywords, progress, originalMessage = "") {
        const duration = tripState.duration_minutes || 120;
        const radius = Math.min(tripState.max_walk_meters || Infinity, duration <= 60 ? 2000 : duration <= 120 ? 3500 : 5000);
        let allPois = await searchCatalog(keywords, radius, originalMessage, progress);
        for (let index = 0; index < keywords.length; index += 1) {
            progress.setStage(1, `${index + 1}/${keywords.length} · ${keywords[index]}`);
            const pois = await waitForMap(searchOneKeyword(keywords[index], radius));
            allPois = allPois.concat(pois);
        }
        const seen = [];
        return allPois.filter(poi => {
            const baseName = poi.name.replace(/[（(].*?[）)]/g, "");
            if (core.normalizeName(baseName) === core.normalizeName(currentStartName)
                && haversineDistance(currentUserPoint, poi.point) < 100) return false;
            if (seen.some(previous => core.normalizeName(previous.name) === core.normalizeName(poi.name)
                || (previous.catalog && core.matchesCatalogPlace(poi, previous.catalog)))) return false;
            seen.push(poi);
            return true;
        });
    }

    async function filterPois(pois, originalMessage) {
        if (!pois.length) return [];
        const searching = ["find_places", "nearby_help"].includes(executionIntent?.proposal?.intent);
        const removeObviousNonDestinations = items => {
            const excluded = /(有限公司|软件科技|物业|停车场|加油站|银行|医院|诊所|房产|培训|瑜伽馆|办事处|写字楼)/;
            return items.filter(item => !excluded.test(item.name) && core.isUsablePoi(item)
                && !(searching ? [] : tripState.excluded_places || []).some(term => core.samePlace(item.name, term) || core.categoryMatches(item, term)));
        };
        try {
            const data = await requestJson("/api/filter_pois", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    poi_names: pois.map(poi => poi.name),
                    user_message: JSON.stringify({ request: originalMessage, active_theme: searching ? executionIntent.proposal.query.keywords : tripState.theme,
                        interpretation: executionIntent?.proposal?.interpretation }),
                    poi_details: pois.map(poi => ({ name: poi.name, address: poi.address, tags: poi.tags,
                        category: poi.category, keyword: poi.keyword })),
                    history: searching ? [] : chatHistory.slice(-10)
                })
            });
            responseStatus(data, "filter");
            if (!Array.isArray(data.filtered_names)) return removeObviousNonDestinations(pois);
            const keep = new Set(data.filtered_names);
            const requiredCategories = searching ? [] : [...(tripState.required_categories || []),
                ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))];
            // Model ranking cannot silently discard every verified bookstore or garden.
            return removeObviousNonDestinations(pois.filter(poi => keep.has(poi.name)
                || requiredCategories.some(category => core.categoryMatches(poi, category))));
        } catch (_) {
            if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
            responseStatus({ source: "fallback", fallback_reason: "model_network_error" }, "filter");
            return removeObviousNonDestinations(pois);
        }
    }

    function buildRoute(pois, keywords) {
        const duration = tripState.duration_minutes || 120;
        let maxStops = duration <= 60 ? 3 : duration <= 120 ? 4 : 5;
        if (tripState.pace === "relaxed") maxStops = Math.max(2, maxStops - 1);
        if (tripState.pace === "packed") maxStops = Math.min(5, maxStops + 1);
        maxStops = Math.min(12, tripState.max_stops ?? 12, Math.max(maxStops, tripState.min_stops ?? 1));
        const maxDistance = Math.min(tripState.max_walk_meters || Infinity, duration * 45);

        const chosen = [];
        const preferCatalogThenDistance = (a, b) => Number(Boolean(b.catalog)) - Number(Boolean(a.catalog))
            || haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point);
        const buckets = keywords.map(keyword => pois
            .filter(poi => poi.keyword === keyword)
            .sort(preferCatalogThenDistance));

        // 按主题轮流取点，避免“老洋房 + 咖啡”最后全是咖啡店。
        while (chosen.length < maxStops && buckets.some(bucket => bucket.length)) {
            let addedThisRound = false;
            for (const bucket of buckets) {
                const match = bucket.find(poi => !chosen.includes(poi));
                if (match && chosen.length < maxStops) {
                    chosen.push(match);
                    addedThisRound = true;
                }
            }
            if (!addedThisRound) break;
        }

        pois
            .filter(poi => !chosen.includes(poi))
            .sort(preferCatalogThenDistance)
            .slice(0, Math.max(0, maxStops - chosen.length))
            .forEach(poi => chosen.push(poi));

        const ordered = [];
        const remaining = [...chosen];
        let cursor = currentUserPoint;
        let approximateDistance = 0;
        while (remaining.length) {
            remaining.sort((a, b) => haversineDistance(cursor, a.point) - haversineDistance(cursor, b.point));
            const next = remaining.shift();
            const legDistance = haversineDistance(cursor, next.point);
            if (approximateDistance + legDistance > maxDistance) continue;
            approximateDistance += legDistance;
            ordered.push(next);
            cursor = next.point;
        }

        return [
            { name: currentStartName || tripState.start || "我的起点", point: currentUserPoint, isStart: true },
            ...ordered.map(poi => ({
                ...poi,
                reason: poi.catalog ? `地点库标签：${poi.catalog.tags.filter(tag => /[\u4e00-\u9fff]/.test(tag)).slice(0, 3).join("、")}；名称与地址已由地图核对。`
                    : `按“${poi.keyword || keywords[0]}”检索，并且与前后地点步行衔接较顺。`
            }))
        ];
    }

    function walkingPathBetween(start, end) {
        const key = `${start.lng},${start.lat}>${end.lng},${end.lat}`;
        if (walkingCache.has(key)) return Promise.resolve(walkingCache.get(key));
        return new Promise(resolve => {
            if (!map) return resolve(null);
            let settled = false;
            const finish = leg => {
                if (settled) return;
                settled = true;
                if (leg) walkingCache.set(key, leg);
                resolve(leg);
            };
            const walk = new BMapGL.WalkingRoute(map);
            walk.setSearchCompleteCallback(result => {
                if (walk.getStatus() === BMAP_STATUS_SUCCESS && result?.getPlan(0)) {
                        const plan = result.getPlan(0);
                        const path = plan.getRoute(0)?.getPath?.() || [];
                        const routeSegment = plan.getRoute(0);
                        const steps = [];
                        for (let i = 0; i < Math.min(routeSegment?.getNumSteps?.() || 0, 100); i++) {
                            const instruction = routeSegment.getStep(i)?.getDescription?.(false);
                            if (typeof instruction === "string" && instruction.trim()) steps.push(instruction.trim());
                        }
                    const distance = Number(plan.getDistance(false));
                    const seconds = Number(plan.getDuration(false));
                    finish(path.length && Number.isFinite(distance) && Number.isFinite(seconds)
                        ? { path, distance, walkingMinutes: seconds / 60, steps } : null);
                } else {
                    finish(null);
                }
            });
            walk.search(start, end);
            window.setTimeout(() => finish(null), 9000);
        });
    }

    async function measureRoute(route) {
        const metrics = { path: [], distance: 0, walkingMinutes: 0, verified: true };
        for (let index = 0; index < route.length - 1; index += 1) {
            const leg = await waitForMap(walkingPathBetween(route[index].point, route[index + 1].point));
            if (!leg) throw new RouteError("地图暂时没有返回可核验的步行路线，请稍后重试；不会用直线距离冒充步行距离");
            metrics.path.push(...leg.path);
            metrics.distance += leg.distance;
            metrics.walkingMinutes += leg.walkingMinutes;
        }
        return metrics;
    }

    function paintRoute(route, metrics) {
        if (!map) return;
        map.clearOverlays();
        addStartMarker();
        const fullPath = metrics?.path || [];

        if (fullPath.length > 1) {
            map.addOverlay(new BMapGL.Polyline(fullPath, {
                strokeColor: "#4facfe",
                strokeWeight: 5,
                strokeOpacity: 0.85
            }));
        }

        route.slice(1).forEach((stop, index) => {
            const marker = new BMapGL.Marker(stop.point);
            const label = new BMapGL.Label(isMobileLayout() ? `${index + 1}` : `${index + 1}. ${stop.name}`,
                { offset: new BMapGL.Size(15, -25) });
            label.setStyle({
                color: "#fff",
                backgroundColor: "#e74c3c",
                border: "none",
                borderRadius: "6px",
                padding: "5px 9px",
                fontSize: "12px"
            });
            marker.setLabel(label);
            marker.addEventListener("click", () => askAboutPlace(stop));
            map.addOverlay(marker);
        });

        discoveryOverlays = [];
        discoveryPlaces.forEach((poi, index) => {
            const marker = new BMapGL.Marker(poi.point);
            const label = new BMapGL.Label(isMobileLayout() ? `备选${index + 1}` : `备选${index + 1} · ${poi.name}`, { offset: new BMapGL.Size(12, -20) });
            label.setStyle({ backgroundColor: "#087f8c", color: "white", border: "none", padding: "4px" });
            marker.setLabel(label);
            marker.addEventListener("click", () => askAboutPlace(poi));
            map.addOverlay(marker); discoveryOverlays.push(marker);
        });
        if (walkingGuide) {
            map.addOverlay(new BMapGL.Polyline(walkingGuide.leg.path, { strokeColor: "#ff9800", strokeWeight: 7, strokeOpacity: 0.95 }));
            for (const [labelText, point] of [["指引出发点", walkingGuide.from], ["指引目的地", walkingGuide.to]]) {
                const marker = new BMapGL.Marker(point);
                const label = new BMapGL.Label(labelText, { offset: new BMapGL.Size(10, -20) });
                label.setStyle({ backgroundColor: "#d66a00", color: "white", border: "none", padding: "4px" });
                marker.setLabel(label); map.addOverlay(marker);
            }
        }
        const viewportPoints = walkingGuide ? walkingGuide.leg.path : discoveryPlaces.length ? discoveryPlaces.map(poi => poi.point)
            : fullPath.length ? fullPath : route.map(item => item.point);
        // The mobile map stays laid out beneath the chat view. Fit only after
        // layout, with space for the floating route header and bottom CTA.
        if (viewportPoints.length) {
            const top = isMobileLayout() ? Math.min(280, (routePanel.getBoundingClientRect?.().height || 66) + 45) : 55;
            const bottom = isMobileLayout() ? 110 : 55;
            const options = { margins: [top, 80, bottom, 55], delay: 0 };
            if (isMobileLayout() && map.getViewport && map.getSize) {
                // The SDK's margin fit can zoom in on a short landscape map.
                // Cap it using the actual space left between the panel and CTA.
                const size = map.getSize();
                const scale = Math.min((size.width - 135) / size.width, (size.height - top - bottom) / size.height);
                if (scale > 0 && scale < 1) {
                    const base = map.getViewport(viewportPoints, { margins: [0, 0, 0, 0] });
                    const fitted = map.getViewport(viewportPoints, options);
                    options.zoomFactor = Math.min(0, base.zoom + Math.log2(scale) - fitted.zoom);
                }
            }
            map.setViewport(viewportPoints, options);
        }
    }

    function protectedStop(stop, route = currentRoute) {
        return stop.isEnd || (tripState.required_places || []).some(name => core.samePlace(stop.name, name))
            || [...(tripState.required_categories || []), ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))]
                .some(category => core.categoryMatches(stop, category)
                && !route.some(other => !other.isStart && !core.samePlace(other.name, stop.name) && core.categoryMatches(other, category)));
    }

    function routeViolations(route, metrics) {
        return [...core.validateRoute(route, tripState, metrics),
            ...core.validateGoals(route, metrics, executionIntent?.proposal?.relative_goals || {}, executionIntent?.comparison_baseline || {})];
    }

    async function publishRoute(proposed, allowTrim = false) {
        let route = proposed.map((stop, index) => ({ ...stop,
            isEnd: Boolean(index > 0 && tripState.end && core.samePlace(stop.name, tripState.end)) }));
        if (route.length <= 1) throw new RouteError("没有找到满足条件的游览地点，可以换主题或放宽距离");
        let metrics = await measureRoute(route);
        let violations = routeViolations(route, metrics);
        while (allowTrim && violations.length && route.length > 2) {
            const removable = route.map((stop, index) => ({ stop, index }))
                .filter(({ stop, index }) => index > 0 && !protectedStop(stop, route));
            if (!removable.length) break;
            route.splice(removable.at(-1).index, 1);
            metrics = await measureRoute(route);
            violations = routeViolations(route, metrics);
        }
        if (violations.length) throw new RouteError(violations.join("；"));
        if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
        currentRoute = route;
        currentMetrics = metrics;
        currentRouteDistance = metrics.distance;
        currentUserPoint = route[0].point;
        currentStartName = route[0].name;
        discoveryPlaces = [];
        discoveryQuery = null;
        walkingGuide = null;
        tripState.start = currentStartName;
        gpsInput.value = currentStartName;
        paintRoute(route, metrics);
        renderRoute(route, metrics.distance);
        renderUnderstanding({ interpretation: "路线已校验并生效；开放时间请以场馆公告为准。" });
        lastActionSummary = `已生效：从${currentStartName}出发，${route.slice(1).map(stop => stop.name).join(" → ")}。步行约${Math.ceil(metrics.distance)}米。`;
        if (isMobileLayout()) { setPanelExpanded(false); setMobileView("map"); }
        return true;
    }

    function renderRoute(route, distance) {
        routeList.replaceChildren();
        if (!route.length) {
            document.getElementById("panel-title").textContent = "📍 起点与路线";
            routeList.textContent = "尚无已生效路线，请告诉我起点、时长和主题。";
            routeSummary.classList.remove("visible");
            return;
        }
        route.forEach((stop, index) => {
            const item = document.createElement("li");
            if (stop.isStart) {
                item.className = "start-point";
                item.textContent = `📍 起点：${stop.name}`;
            } else {
                item.className = "route-stop";
                const name = document.createElement("span");
                name.className = "route-stop-name";
                name.textContent = `${index}. ${stop.name}`;
                const reason = document.createElement("span");
                reason.className = "route-stop-reason";
                reason.textContent = stop.reason || "位于当前路线的合理步行范围内。";
                item.append(name, reason);
                item.addEventListener("click", () => {
                    map?.panTo(stop.point);
                    askAboutPlace(stop);
                });
            }
            routeList.appendChild(item);
        });

        const minutes = Math.ceil((currentMetrics?.walkingMinutes || 0) + core.estimatedVisitMinutes(route, tripState));
        routeSummary.textContent = `步行 ${Math.ceil(distance)} 米 · 含停留预计 ${minutes} 分钟 · ${route.length - 1} 站`;
        document.getElementById("panel-title").textContent = `📍 ${route.length - 1} 站 · 步行 ${Math.ceil(distance)} 米`;
        routeSummary.classList.add("visible");
        document.getElementById("panel").scrollTop = 0;
    }

    function appendRouteResult(route, distance, interpretation) {
        const { bubble } = createMessageShell("assistant");
        const title = document.createElement("strong");
        const minutes = Math.ceil(currentMetrics.walkingMinutes + core.estimatedVisitMinutes(route, tripState));
        title.textContent = `路线已生效：${route.length - 1} 站 · 步行 ${Math.ceil(distance)} 米 · 含停留预计 ${minutes} 分钟`;
        bubble.appendChild(title);
        if (interpretation) {
            const description = document.createElement("div");
            description.className = "theme-note";
            description.textContent = interpretation;
            bubble.appendChild(description);
        }
        route.slice(1).forEach((stop, index) => {
            const line = document.createElement("div");
            line.style.marginTop = "7px";
            line.textContent = `${index + 1}. ${stop.name}：${stop.reason || "来自本次地图检索，并已核对步行连接。"}`;
            bubble.appendChild(line);
            if (stop.catalog?.sources?.length) {
                const source = stop.catalog.sources.find(item => /^https:\/\//.test(item.url));
                if (source) {
                    const link = document.createElement("a");
                    link.textContent = "查看地点资料 ↗";
                    link.href = source.url;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    link.style.cssText = "display:inline-block;color:#8fcdf5;font-size:12px;padding:5px 0";
                    bubble.appendChild(link);
                }
            }
        });
        const hint = document.createElement("div");
        hint.className = "theme-note";
        hint.textContent = "可继续指定顺序、删改地点，或说“撤销上一步”。停留时间为估算，营业开放信息未核实。";
        bubble.appendChild(hint);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function resolveNamedStop(name) {
        const known = [...currentRoute.slice(1), ...discoveryPlaces].filter(stop => core.samePlace(stop.name, name));
        const existing = known.length === 1 ? known[0] : null;
        if (existing) return { ...existing, isEnd: false };
        const point = await waitForMap(geocodeAddress(name));
        if (!point) throw new RouteError(`无法确认“${name}”的准确位置，请在左上角搜索核对完整名称`);
        const poi = resolvedPlaces.get(name);
        return { name: poi?.title || name, point, address: poi ? formatPoiAddress(poi) : "", tags: poi?.tags,
            category: poi?.category, keyword: "指定地点", reason: "你指定的地点；请现场核实是否开放。" };
    }

    async function planRoute(keywords, originalMessage, interpretation = "") {
        if (!(await ensureStartPoint())) return false;
        if (executionIntent?.proposal?.selection_mode === "only_specified" && tripState.required_places?.length) {
            const exactRoute = [{ name: currentStartName, point: currentUserPoint, isStart: true }];
            for (const name of tripState.required_places) exactRoute.push(await resolveNamedStop(name));
            if (tripState.end || tripState.end_category) await addRouteEnd(exactRoute, tripState.end_category || tripState.end, Boolean(tripState.end_category));
            await publishRoute(exactRoute, false);
            appendRouteResult(currentRoute, currentRouteDistance, "只包含你指定的地点，没有额外加站。");
            return true;
        }
        const usableKeywords = [...new Set([...(tripState.required_categories || []),
            ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme)),
            ...(Array.isArray(keywords) && keywords.length ? keywords : tripState.theme?.length ? tripState.theme : ["历史建筑", "公园"])])].slice(0, 4);
        const progress = appendPlanningProgress();
        activeProgress = progress;
        progress.setStage(1, usableKeywords.join(" / "));
        const pois = await searchPois(usableKeywords, progress, originalMessage);
        progress.setStage(2, `${pois.length} 个候选 · ${pois.filter(poi => poi.catalog).length} 个来自已核对地点库`);
        let filtered = await filterPois(pois, originalMessage);
        // End-type service is selected once at the end, not interleaved into the main theme.
        if (tripState.end_category && !(tripState.theme || []).some(theme => theme === tripState.end_category)) {
            filtered = filtered.filter(poi => !core.categoryMatches(poi, tripState.end_category));
        }
        const route = buildRoute(filtered, usableKeywords);
        const mustHave = [...new Set([...(tripState.required_categories || []), ...(tripState.theme || []).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))])];
        for (const category of mustHave) {
            if (route.slice(1).some(stop => core.categoryMatches(stop, category))) continue;
            const candidate = filtered.filter(poi => core.categoryMatches(poi, category))
                .sort((a, b) => haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point))[0];
            if (!candidate) throw new RouteError(`附近没有找到可确认的“${category}”地点，请换一个主题或起点`);
            if (!route.some(stop => core.samePlace(stop.name, candidate.name))) route.push({ ...candidate, reason: `满足“${category}”主题。` });
        }
        // Theme coverage is checked for this route, never persisted as a new hard constraint.
        for (const name of tripState.required_places || []) {
            if (!route.some(stop => core.samePlace(stop.name, name))) route.push(await resolveNamedStop(name));
        }
        if (!route.slice(1).length) throw new RouteError("附近未找到有依据的主题游览点；可以先查看备选地点或换个区域，不会只用咖啡终点冒充主题路线");
        if (tripState.end || tripState.end_category) await addRouteEnd(route, tripState.end_category || tripState.end, Boolean(tripState.end_category));
        progress.setStage(3, "核对距离、必去与排除条件");
        await publishRoute(route, true);
        progress.complete();
        // Describe the actual committed stops, never the model's unexecuted itinerary.
        appendRouteResult(currentRoute, currentRouteDistance, [interpretation || executionIntent?.proposal?.interpretation,
            executionIntent?.proposal?.theme_status === "abstract_valid" ? "抽象主题按氛围近似检索，不代表这些地点实际提供科幻或科技体验。" : "",
            "已核对地点和步行距离；主题匹配是候选建议，不代表已核实现场体验。"].filter(Boolean).join(" "));
        return true;
    }

    async function addRouteEnd(route, requestedEnd, isCategory = false) {
        if (!requestedEnd) return true;
        const category = isCategory ? requestedEnd : null;
        let candidate;
        if (category) {
            const keyword = category;
            const last = route.at(-1);
            const found = await waitForMap(searchOneKeyword(keyword, 1200, last.point));
            candidate = found.filter(poi => core.isUsablePoi(poi) && core.categoryMatches(poi, keyword))
                .sort((a, b) => haversineDistance(last.point, a.point) - haversineDistance(last.point, b.point))[0];
        } else {
            candidate = await resolveNamedStop(requestedEnd);
        }
        if (!candidate) throw new RouteError(`未找到合适的“${requestedEnd}”作为终点`);
        const proposed = route.filter(stop => stop.isStart || !core.samePlace(stop.name, candidate.name))
            .map(stop => ({ ...stop, isEnd: false }));
        proposed.push({ ...candidate, isEnd: true, reason: "你指定的最后一站。" });
        route.splice(0, route.length, ...proposed);
        tripState.end = candidate.name;
        return true;
    }

    async function applyRouteModification(modification, keywords, originalMessage) {
        const operation = modification?.operation;
        if (operation === "undo" || operation === "restore_initial") {
            const snapshot = operation === "restore_initial" ? initialSnapshot : routeSnapshots.at(-1);
            if (!snapshot) throw new RouteError("还没有可恢复的路线版本");
            restoreSnapshot(snapshot);
            if (operation === "undo") routeSnapshots.pop();
            else routeSnapshots = [];
            lastActionSummary = operation === "restore_initial" ? "已恢复第一次生成的路线、起点和条件。" : "已撤销上一步，路线、起点和条件一起恢复。";
            appendMessage("assistant", lastActionSummary);
            return true;
        }
        if (currentRoute.length <= 1) throw new RouteError("现在还没有可修改的路线，请先告诉我起点、时长和主题");
        if (["extend", "shorten", "adjust_constraints"].includes(operation)
            || (operation === "reorder" && !modification.places?.length && executionIntent?.proposal?.relative_goals?.distance))
            return adjustRouteConstraints(keywords, originalMessage);
        if (["replan", "change_theme", "change_start"].includes(operation)) {
            if (operation === "change_start" && modification.value) tripState.start = modification.value;
            return planRoute(keywords?.length ? keywords : tripState.theme, originalMessage);
        }
        let proposed = currentRoute.map(stop => ({ ...stop }));
        let description = "路线已更新。";
        let allowTrim = false;
        if (operation === "change_end") {
            // Clearing a fixed destination keeps the stop itself, as requested.
            proposed = proposed.map(stop => ({ ...stop, isEnd: false,
                reason: stop.isEnd && !modification.value ? "保留这个地点，不再设为固定终点。" : stop.reason }));
            tripState.end = modification.value || null;
            if (tripState.end || tripState.end_category) await addRouteEnd(proposed, tripState.end || tripState.end_category, Boolean(!tripState.end && tripState.end_category));
            description = tripState.end ? `终点已改为“${tripState.end}”。` : "固定终点已取消，其他地点和顺序不变。";
        } else if (operation === "set_stops") {
            if (!modification.places?.length) throw new RouteError("请明确要保留的地点名称");
            proposed = [proposed[0]];
            for (const name of modification.places) proposed.push(await resolveNamedStop(name));
            tripState.required_places = [...modification.places];
            // An exact replacement supersedes previous optional topic coverage.
            tripState.required_categories = [];
            tripState.theme = [];
            if (tripState.end && !modification.places.some(name => core.samePlace(name, tripState.end))) tripState.end = null;
            if (tripState.end) proposed = core.orderStops(proposed, [...modification.places.filter(name => !core.samePlace(name, tripState.end)), tripState.end]);
            description = "已仅保留你指定的地点。";
        } else if (operation === "reorder") {
            if (!modification.places?.length) throw new RouteError("请说出地点顺序，例如“先去第三站，再去第一站”");
            try { proposed = core.orderStops(proposed, modification.places); }
            catch (error) { throw new RouteError(error.message); }
            description = "已按你指定的顺序排列，其他地点没有删减。";
        } else if (operation === "remove_stop") {
            const targets = modification.places?.length ? modification.places : [modification.target];
            for (const target of targets) {
                const index = currentRoute.findIndex(stop => !stop.isStart && core.samePlace(stop.name, target));
                const actual = proposed.findIndex(stop => !stop.isStart && core.samePlace(stop.name, currentRoute[index]?.name));
                if (actual < 1) throw new RouteError("没能确认要删除哪一站，请使用地点名或第几站");
                const [removed] = proposed.splice(actual, 1);
                tripState.required_places = (tripState.required_places || []).filter(name => !core.samePlace(name, removed.name));
                if (tripState.end && core.samePlace(tripState.end, removed.name)) tripState.end = null;
            }
            description = "已删除指定地点，其他站点保持不变。";
        } else if (operation === "replace_stop" || operation === "add_stop") {
            const index = currentRoute.findIndex(stop => !stop.isStart && core.samePlace(stop.name, modification.target));
            if (operation === "replace_stop" && index < 1) throw new RouteError("请明确要替换哪一站");
            const query = modification.value || tripState.theme?.[0] || keywords?.[0];
            if (!query) throw new RouteError("请告诉我要加入的地点或类别");
            const category = modification.value_kind === "category" ? query : null;
            const candidates = category
                ? await waitForMap(searchOneKeyword(category, Math.min(tripState.max_walk_meters || 3500, 3500)))
                : [await resolveNamedStop(query)];
            const available = candidates.filter(poi => core.isUsablePoi(poi) && (!category || core.categoryMatches(poi, category))
                && !proposed.some(stop => core.samePlace(stop.name, poi.name)))
                .sort((a, b) => haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point));
            if (!available.length) throw new RouteError("附近没有找到符合条件的新地点，原路线保留");
            const candidate = { ...available[0], reason: `按你的要求加入“${query}”。` };
            if (operation === "replace_stop") {
                const oldName = proposed[index].name;
                tripState.required_places = (tripState.required_places || []).map(name => core.samePlace(name, oldName) ? candidate.name : name);
                if (tripState.end && core.samePlace(tripState.end, oldName)) {
                    tripState.end = candidate.name;
                    candidate.isEnd = true;
                }
                proposed[index] = candidate;
            }
            else proposed.splice(proposed.at(-1).isEnd ? proposed.length - 1 : proposed.length, 0, candidate);
            description = operation === "replace_stop" ? "已替换指定地点，其他站保留。" : "已加入新地点。";
        } else {
            throw new RouteError("这项修改暂时无法准确执行，请指定地点或顺序；不会擅自重做整条路线");
        }
        await publishRoute(proposed, allowTrim);
        appendMessage("assistant", `${description}\n${lastActionSummary}`);
        return true;
    }

    async function adjustRouteConstraints(keywords, originalMessage) {
        const goals = executionIntent?.proposal?.relative_goals || {};
        const baseline = executionIntent?.comparison_baseline || {};
        const needsMore = (tripState.min_stops ?? 0) > currentRoute.length - 1
            || goals.stop_count === "increase" || (goals.distance === "increase" && goals.stop_count !== "unchanged");
        let candidates = [];
        if (needsMore || executionIntent?.proposal?.modification?.allow_replace) {
            const queries = keywords?.length ? keywords : tripState.theme?.length ? tripState.theme : ["历史建筑", "公园"];
            const progress = appendPlanningProgress(); activeProgress = progress;
            progress.setStage(1, "检索满足数量与距离条件的候选地点");
            candidates = await filterPois(await searchPois(queries.slice(0, 4), progress, originalMessage), originalMessage);
        }
        const route = currentRoute.map(stop => ({ ...stop }));
        for (const name of tripState.required_places || []) {
            if (!route.some(stop => core.samePlace(stop.name, name))) candidates.push(await resolveNamedStop(name));
        }
        try {
            const result = await core.fitRoute({ route, candidates, state: tripState, goals, baseline,
                allowReplace: Boolean(executionIntent?.proposal?.modification?.allow_replace),
                preserveOrder: Boolean(executionIntent?.proposal?.modification?.preserve_order),
                measure: measureRoute,
                rank: proposed => proposed.slice(1).reduce((sum, stop, i) => sum + haversineDistance(proposed[i].point, stop.point), 0) });
            await publishRoute(result.route, false);
        } catch (error) {
            if (error.name === "AbortError") throw error;
            throw new RouteError(error.message);
        }
        activeProgress?.complete();
        appendRouteResult(currentRoute, currentRouteDistance,
            `已按独立的数量和距离条件核验：${baseline.stop_count} → ${currentRoute.length - 1} 站，${Math.ceil(baseline.total_distance_meters)} → ${Math.ceil(currentRouteDistance)} 米。`);
        return true;
    }

    function askAboutPlace(stop) {
        if (isBusy) return;
        if (isMobileLayout()) setMobileView("chat");
        sendMessage(`介绍一下${stop.name}，并说明它为什么适合我现在这条路线`);
    }

    async function discoverPlaces(query, facility, originalMessage) {
        if (!map) throw new RouteError("地图未就绪，暂时无法标注地点。请稍后重试");
        const center = await waitForMap(geocodeAddress(query.location));
        if (!center) throw new RouteError(`未确认“${query.location}”的位置，请补充附近地标或完整站名`);
        const radius = facility ? 1200 : 2500;
        let found = (await waitForMap(Promise.all(query.keywords.map(word => searchOneKeyword(word, radius, center, facility))))).flat();
        if (!facility) {
            const data = await requestJson(`/api/places/search?query=${encodeURIComponent(query.keywords.join(" "))}&limit=8`);
            const curated = await waitForMap(Promise.all((data.places || []).map(entry => resolveCatalogPlace(entry, radius, center))));
            found = [...curated.filter(Boolean), ...found];
            found = await filterPois(found, JSON.stringify({ request: originalMessage, search: query }));
        }
        const excluded = query.exclude_existing ? [...currentRoute.slice(1), ...discoveryPlaces] : [];
        const unique = [];
        for (const poi of found) {
            if (!unique.some(other => core.samePlace(other.name, poi.name)) && !excluded.some(other => core.samePlace(other.name, poi.name))) unique.push(poi);
        }
        let selected = unique.sort((a, b) => haversineDistance(center, a.point) - haversineDistance(center, b.point)).slice(0, 5);
        if (facility) {
            selected = (await waitForMap(Promise.all(selected.map(async poi => ({ ...poi,
                walking: await walkingPathBetween(center, poi.point) }))))).sort((a, b) => (a.walking?.distance ?? Infinity) - (b.walking?.distance ?? Infinity));
        }
        if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
        if (!selected.length) {
            return "本次搜索范围内没有找到新的、可确认的候选，未重复推荐原地点，原路线没有改变。可以换个区域或放宽主题。";
        }
        discoveryPlaces = selected;
        discoveryQuery = { ...query };
        walkingGuide = null;
        paintRoute(currentRoute, currentMetrics);
        if (isMobileLayout()) { setPanelExpanded(false); setMobileView("map"); }
        return `${facility ? "已查找卫生间等所需设施" : "已标出备选地点（未加入路线）"}，以“${query.location}”为搜索中心，原路线和起点未改。\n`
            + selected.map((poi, index) => `${index + 1}. ${poi.name}｜${poi.address || "地图未提供地址"}｜${poi.walking ? `步行约${Math.ceil(poi.walking.distance)}米` : `直线约${Math.ceil(haversineDistance(center, poi.point))}米，非步行距离`}`).join("\n")
            + (facility ? "\n仅按你提供的位置查询，未获取实时定位；入口、开放及是否可用请现场确认。紧急时也可就近询问地铁或商场工作人员。" : "\n可指定完整地点名加入路线，或继续找其他候选。地图命中不代表已核实主题体验或开放。") ;
    }

    async function guideToPlace(query) {
        if (query.cancel_navigation) {
            walkingGuide = null;
            discoveryPlaces = [];
            discoveryQuery = null;
            paintRoute(currentRoute, currentMetrics);
            return "已结束临时步行指引，行程路线和起点没有改变。";
        }
        if (!map) throw new RouteError("地图未就绪，暂时不能提供可靠步行指引");
        const from = await waitForMap(geocodeAddress(query.location));
        if (!from) throw new RouteError(`未能唯一核对指引出发点“${query.location}”，请补充完整地标名；原行程未变`);
        const matches = [...currentRoute, ...discoveryPlaces].filter(poi => core.samePlace(poi.name, query.targets[0]));
        let to = matches.length === 1 ? matches[0].point : await waitForMap(geocodeAddress(query.targets[0]));
        if (!to) {
            // Resolve ambiguous map titles against a server-owned street/door number,
            // not a fuzzy text match or guessed coordinate.
            const catalog = await requestJson(`/api/places/search?query=${encodeURIComponent(query.targets[0])}&limit=8`);
            const exact = (catalog.places || []).filter(entry => core.samePlace(entry.name, query.targets[0]));
            if (exact.length === 1) to = (await waitForMap(resolveCatalogPlace(exact[0], 20000, from)))?.point;
        }
        if (!to) throw new RouteError(`未能唯一核对指引目的地“${query.targets[0]}”，请补充完整地点名；原行程未变`);
        const leg = await waitForMap(walkingPathBetween(from, to));
        if (!leg) throw new RouteError("地图没有返回可核验的步行路径，暂时不能指路；不会编造转弯方向");
        if (activeRequest?.signal.aborted) throw new DOMException("已取消", "AbortError");
        walkingGuide = { from, to, leg };
        paintRoute(currentRoute, currentMetrics);
        if (isMobileLayout()) { setPanelExpanded(false); setMobileView("map"); }
        return `从“${query.location}”到“${query.targets[0]}”：步行约${Math.ceil(leg.distance)}米，约${Math.ceil(leg.walkingMinutes)}分钟。橙色线是本次指引，原行程未改。\n`
            + (leg.steps?.length ? leg.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
                : "地图只返回路径，未提供文字转弯步骤；请查看橙色线，不推测左右方向。")
            + "\n按你提供的地标位置计算，未实时追踪；请核对现场路牌、过街及入口。位置变了可以告诉我重新查，或说‘结束导航’。";
    }

    async function sendMessage(providedText = "") {
        const text = (providedText || chatInput.value).trim();
        if (!text || isBusy) return;
        ++interactionVersion;
        hasInteraction = true;
        turnChatResponse = null;
        chatInput.value = "";
        appendMessage("user", text);
        const before = captureSnapshot();

        const thinkingRow = appendMessage("assistant", "● 正在理解你的需求…");
        activeRequest = new AbortController();
        setBusy(true);
        serviceStatus.textContent = "本轮处理中…";
        serviceStatus.title = "正在处理这条消息，临时失败会自动重试一次。";
        let actionStarted = false;
        try {
            const result = await requestJson("/api/intent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    history: chatHistory.slice(-12),
                    trip_state: tripState,
                    pending_task: pendingTask,
                    discovery_places: discoveryPlaces.map(poi => poi.name),
                    discovery_query: discoveryQuery,
                    current_route: {
                        places: currentRoute.slice(1).map(stop => stop.name), stop_count: Math.max(0, currentRoute.length - 1),
                        total_distance_meters: currentMetrics?.verified ? currentRouteDistance : null,
                        estimated_duration_minutes: currentMetrics ? currentMetrics.walkingMinutes + core.estimatedVisitMinutes(currentRoute, tripState) : null,
                        can_undo: routeSnapshots.length > 0, can_restore_initial: Boolean(initialSnapshot)
                    }
                })
            }, 65000);
            thinkingRow.remove();
            executionIntent = result;
            const data = { ...(result.proposal || {}), source: result.source, recovered: result.recovered,
                failure_reason: result.failure_reason, trip_state: result.trip_state, action: result.action };
            responseStatus(data);
            const action = result.status === "ready" ? result.action : null;
            if (result.status !== "unavailable") {
                pendingTask = ["find_places", "nearby_help", "navigate"].includes(data.intent) && data.query
                    ? { intent: data.intent, query: data.query } : null;
            }
            let actionSummary;
            if (action === "navigate") {
                actionSummary = await guideToPlace(data.query);
                pendingTask = null;
                appendMessage("assistant", actionSummary);
            } else if (action === "find_places" || action === "nearby_help") {
                actionSummary = await discoverPlaces(data.query, action === "nearby_help", text);
                pendingTask = null;
                appendMessage("assistant", actionSummary);
            } else if (action === "plan_route" || action === "modify_route") {
                actionStarted = true;
                tripState = { ...tripState, ...(data.trip_state || {}) };
                for (const field of data.clear_fields || []) {
                    if (field in tripState) tripState[field] = Array.isArray(tripState[field]) ? [] : null;
                }
                // Do not display the model's proposed stop list or premature success.
                appendMessage("assistant", data.source === "fallback" && data.fallback_reason !== "rule_based"
                    ? `${failureDescription(data)}，本轮使用备用处理；我会继续核对地图结果。`
                    : "正在按你的要求核对地点和路线，完成后会告诉你实际改动。");
                const succeeded = action === "plan_route"
                    ? await planRoute(data.keywords, text)
                    : await applyRouteModification(data.modification, data.keywords, text);
                if (!succeeded) {
                    restoreSnapshot(before);
                    actionSummary = "本次没有生成或修改路线，等待补充起点或条件。";
                } else {
                    if (!["undo", "restore_initial"].includes(data.modification?.operation)) {
                        if (before.route.length > 1) routeSnapshots.push(before);
                        routeSnapshots = routeSnapshots.slice(-10);
                        if (!initialSnapshot) initialSnapshot = captureSnapshot();
                    }
                    actionSummary = lastActionSummary;
                }
            } else {
                // A chat reply must never overwrite an already committed route's labels.
                let reply = result.status === "unavailable"
                    ? `${failureDescription(result)}，本轮没有修改路线或条件。可以点击发送重试，下一条消息也会重新连接 AI。`
                    : result.status === "needs_clarification"
                        ? (result.validation_issues?.join("；") || data.clarification || data.reply)
                        : data.reply || "请告诉我起点、时长和想逛的主题。";
                if (result.status === "ready" && data.intent === "explain_place") {
                    try {
                        const answer = await requestJson("/api/place_answer", { method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ message: text, history: chatHistory.slice(-12), trip_state: tripState, current_route: result.comparison_baseline,
                                answer_targets: data.query?.targets || [] }) });
                        reply = answer.reply;
                        if (!["model", "catalog"].includes(answer.source)) {
                            serviceStatus.textContent = "意图已理解 · 讲解未完成";
                            serviceStatus.title = failureDescription(answer);
                        }
                    } catch (error) {
                        if (activeRequest?.signal.aborted) throw error;
                        reply = "已理解你要查询的地点，但这次资料讲解未完成，路线没有改变；开放信息请向场馆核实。";
                        serviceStatus.textContent = "意图已理解 · 讲解未完成";
                    }
                }
                appendMessage("assistant", data.source === "fallback" && data.fallback_reason !== "rule_based"
                    ? `${failureDescription(data)}，这条先用备用回复，下一条会继续尝试 AI。\n${reply}` : reply);
                actionSummary = reply;
                if (result.status === "unavailable" && !chatInput.value) chatInput.value = text;
            }
            chatHistory.push({ role: "user", content: text }, { role: "assistant", content: actionSummary });
            chatHistory = chatHistory.slice(-16);
        } catch (error) {
            thinkingRow.remove();
            if (actionStarted) restoreSnapshot(before);
            const cancelled = activeRequest?.signal.aborted;
            if (cancelled) serviceStatus.textContent = "已停止本次请求";
            else if (!actionStarted) serviceStatus.textContent = "本次请求未完成";
            const message = cancelled ? "已停止等待，可以重新发送。原路线没有改变。" : error instanceof RouteError
                ? `这次没有生效：${error.message.replace(/[。；;]+$/, "")}。\n${before.route.length > 1 ? "原路线已保留。你可以调整条件再试。" : "还没有生成路线，请调整条件再试。"}`
                : error.name === "AbortError" ? "这次等待超时了，可以重新发送。原路线没有改变。"
                : actionStarted ? "地图处理暂时失败，本次修改没有生效，原路线已保留。请重试。"
                : "没有连上服务。请双击“启动 Demo.cmd”，再打开 http://127.0.0.1:8000。";
            appendMessage("assistant", message, "error");
            activeProgress?.fail("本次未生效");
            chatHistory.push({ role: "user", content: text }, { role: "assistant", content: message });
            chatHistory = chatHistory.slice(-16);
            if (!chatInput.value && !(error instanceof RouteError)) chatInput.value = text;
        } finally {
            activeRequest = null;
            executionIntent = null;
            activeProgress = null;
            setBusy(false);
            if (!isMobileLayout() || appRoot.dataset.mobileView === "chat") chatInput.focus();
        }
    }

    gpsInput.addEventListener("input", () => {
        clearTimeout(gpsDebounceTimer);
        gpsDebounceTimer = setTimeout(() => requestGpsSuggestions(gpsInput.value), 300);
    });
    gpsInput.addEventListener("focus", () => {
        if (gpsInput.value.trim() && !selectedGpsSuggestion) requestGpsSuggestions(gpsInput.value);
    });
    gpsInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            setStartFromInput();
        } else if (event.key === "Escape") {
            hideGpsSuggestions();
        }
    });
    gpsInput.addEventListener("blur", () => {
        cancelGpsSearch();
        setTimeout(() => {
            if (document.activeElement !== gpsInput) hideGpsSuggestions();
        }, 150);
    });
    setStartButton.addEventListener("click", setStartFromInput);
    undoButton?.addEventListener("click", () => sendMessage("撤销上一步"));
    panelToggle?.addEventListener("click", () => setPanelExpanded(routePanel.dataset.expanded !== "true"));
    mobileMapTab?.addEventListener("click", () => { setPanelExpanded(false); setMobileView("map"); });
    mobileChatTab?.addEventListener("click", () => setMobileView("chat"));
    document.getElementById("map-chat-button")?.addEventListener("click", () => setMobileView("chat"));
    window.visualViewport?.addEventListener("resize", syncViewportHeight);
    window.addEventListener?.("resize", syncViewportHeight);
    syncViewportHeight();

    chatInput.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            sendMessage();
        }
    });
    sendButton.addEventListener("click", () => {
        if (isBusy) activeRequest?.abort();
        else sendMessage();
    });
    document.querySelectorAll(".quick-prompt").forEach(button => {
        button.addEventListener("click", () => sendMessage(button.textContent));
    });

    checkService();
    loadMap();
})();
