(() => {
    "use strict";

    const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
    const DEFAULT_CENTER = { lng: 121.445, lat: 31.205 };
    const PACE_LABELS = { relaxed: "轻松慢逛", normal: "正常节奏", packed: "紧凑多逛" };

    let map = null;
    let currentUserPoint = null;
    let currentStartName = "";
    let currentRoute = [];
    let currentRouteDistance = 0;
    let chatHistory = [];
    let tripState = {
        start: null,
        duration_minutes: null,
        theme: [],
        pace: null,
        end: null,
        constraints: []
    };
    let selectedGpsSuggestion = null;
    let gpsDebounceTimer = null;
    let gpsSearchSeq = 0;
    let isBusy = false;

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
        sendButton.disabled = value;
        chatInput.disabled = value;
        sendButton.setAttribute("aria-busy", String(value));
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
        if (tripState.duration_minutes) chips.push(`时长 · ${formatDuration(tripState.duration_minutes)}`);
        if (tripState.theme?.length) chips.push(`主题 · ${tripState.theme.join(" / ")}`);
        if (tripState.pace) chips.push(`节奏 · ${PACE_LABELS[tripState.pace] || tripState.pace}`);
        if (tripState.end) chips.push(`终点 · ${tripState.end}`);

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

    function hideGpsSuggestions() {
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
                        if (poi?.title && poi?.point) pois.push(poi);
                    }
                }
                renderGpsSuggestions(pois);
            }
        });
        local.search(query);
    }

    function geocodeAddress(address) {
        return new Promise(resolve => {
            if (!map || !address) return resolve(null);
            const geocoder = new BMapGL.Geocoder();
            geocoder.getPoint(address, point => resolve(point || null), "上海市");
        });
    }

    function addStartMarker() {
        if (!map || !currentUserPoint) return;
        const marker = new BMapGL.Marker(currentUserPoint);
        const label = new BMapGL.Label("起点", { offset: new BMapGL.Size(15, -18) });
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
        if (!point || !map) return false;
        currentUserPoint = point;
        currentStartName = name;
        selectedGpsSuggestion = selectedGpsSuggestion?.title === name ? selectedGpsSuggestion : null;
        gpsInput.value = name;
        tripState.start = name;

        map.clearOverlays();
        addStartMarker();
        map.panTo(point);

        if (currentRoute.length > 1) {
            currentRoute[0] = { name, point, isStart: true, detailAddress };
            currentRouteDistance = await drawRoute(currentRoute);
            renderRoute(currentRoute, currentRouteDistance);
        } else {
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
        if (!point) {
            appendMessage("assistant", `我还没找到“${address}”，试试输入更具体的上海地标。`);
            return;
        }
        await setStartPoint(point, address);
    }

    async function ensureStartPoint() {
        if (currentUserPoint) return true;
        const proposedStart = tripState.start || gpsInput.value.trim();
        if (!proposedStart) {
            appendMessage("assistant", "还差一个起点。你可以直接说“从上海图书馆出发”，或者在地图左上角设置起点。", "needs-input");
            return false;
        }
        const point = await geocodeAddress(proposedStart);
        if (!point) {
            appendMessage("assistant", `我理解你的起点是“${proposedStart}”，但地图没有找到它。请换一个更具体的地标。`, "needs-input");
            return false;
        }
        await setStartPoint(point, proposedStart);
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

    function searchOneKeyword(keyword, radius) {
        return new Promise(resolve => {
            if (!map || !currentUserPoint) return resolve([]);
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
                            if (poi?.point && poi?.title) {
                                found.push({
                                    name: poi.title,
                                    point: poi.point,
                                    address: formatPoiAddress(poi),
                                    keyword
                                });
                            }
                        }
                    }
                    finish(found);
                }
            });
            local.searchNearby(keyword, currentUserPoint, radius);
            window.setTimeout(() => finish([]), 9000);
        });
    }

    async function searchPois(keywords, progress) {
        const duration = tripState.duration_minutes || 120;
        const radius = duration <= 60 ? 2500 : duration <= 120 ? 4000 : 5000;
        let allPois = [];
        for (let index = 0; index < keywords.length; index += 1) {
            progress.setStage(1, `${index + 1}/${keywords.length} · ${keywords[index]}`);
            const pois = await searchOneKeyword(keywords[index], radius);
            allPois = allPois.concat(pois);
        }
        const seen = new Set();
        return allPois.filter(poi => {
            if (seen.has(poi.name)) return false;
            seen.add(poi.name);
            return true;
        });
    }

    async function filterPois(pois, originalMessage) {
        if (!pois.length) return [];
        const removeObviousNonDestinations = items => {
            const excluded = /(有限公司|软件科技|物业|停车场|加油站|银行|医院|诊所|房产|培训|瑜伽馆|办事处|写字楼)/;
            const suitable = items.filter(item => !excluded.test(item.name));
            return suitable.length ? suitable : items;
        };
        try {
            const response = await fetch(apiUrl("/api/filter_pois"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    poi_names: pois.map(poi => poi.name),
                    user_message: originalMessage,
                    history: chatHistory.slice(-10)
                })
            });
            if (!response.ok) return removeObviousNonDestinations(pois);
            const data = await response.json();
            if (!Array.isArray(data.filtered_names)) return removeObviousNonDestinations(pois);
            const keep = new Set(data.filtered_names);
            return removeObviousNonDestinations(pois.filter(poi => keep.has(poi.name)));
        } catch (_) {
            return removeObviousNonDestinations(pois);
        }
    }

    function buildRoute(pois, keywords) {
        const duration = tripState.duration_minutes || 120;
        let maxStops = duration <= 60 ? 3 : duration <= 120 ? 4 : 5;
        if (tripState.pace === "relaxed") maxStops = Math.max(2, maxStops - 1);
        if (tripState.pace === "packed") maxStops = Math.min(5, maxStops + 1);
        const maxDistance = duration <= 60 ? 2600 : duration <= 120 ? 4200 : 5600;

        const chosen = [];
        const buckets = keywords.map(keyword => pois
            .filter(poi => poi.keyword === keyword)
            .sort((a, b) => haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point)));

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
            .sort((a, b) => haversineDistance(currentUserPoint, a.point) - haversineDistance(currentUserPoint, b.point))
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
            if (ordered.length && approximateDistance + legDistance > maxDistance) break;
            approximateDistance += legDistance;
            ordered.push(next);
            cursor = next.point;
        }

        if (!ordered.length && chosen.length) ordered.push(chosen[0]);
        return [
            { name: currentStartName || tripState.start || "我的起点", point: currentUserPoint, isStart: true },
            ...ordered.map(poi => ({
                ...poi,
                reason: `符合“${poi.keyword || keywords[0]}”主题，并且与前后地点步行衔接较顺。`
            }))
        ];
    }

    function walkingPathBetween(start, end) {
        return new Promise(resolve => {
            if (!map) return resolve([]);
            let settled = false;
            const finish = path => {
                if (settled) return;
                settled = true;
                resolve(path);
            };
            const walk = new BMapGL.WalkingRoute(map);
            walk.setSearchCompleteCallback(result => {
                if (walk.getStatus() === BMAP_STATUS_SUCCESS && result?.getPlan(0)) {
                    const route = result.getPlan(0).getRoute(0);
                    finish(route?.getPath?.() || []);
                } else {
                    finish([]);
                }
            });
            walk.search(start, end);
            window.setTimeout(() => finish([]), 9000);
        });
    }

    async function drawRoute(route) {
        if (!map || !route.length) return 0;
        map.clearOverlays();
        addStartMarker();
        let fullPath = [];
        let actualDistance = 0;

        for (let index = 0; index < route.length - 1; index += 1) {
            const path = await walkingPathBetween(route[index].point, route[index + 1].point);
            const usablePath = path.length ? path : [route[index].point, route[index + 1].point];
            if (fullPath.length && usablePath.length) usablePath.shift();
            fullPath = fullPath.concat(usablePath);
        }

        for (let index = 1; index < fullPath.length; index += 1) {
            actualDistance += haversineDistance(fullPath[index - 1], fullPath[index]);
        }

        if (fullPath.length > 1) {
            map.addOverlay(new BMapGL.Polyline(fullPath, {
                strokeColor: "#4facfe",
                strokeWeight: 5,
                strokeOpacity: 0.85
            }));
        }

        route.slice(1).forEach((stop, index) => {
            const marker = new BMapGL.Marker(stop.point);
            const label = new BMapGL.Label(`${index + 1}. ${stop.name}`, { offset: new BMapGL.Size(15, -25) });
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

        const viewportPoints = fullPath.length ? fullPath : route.map(item => item.point);
        if (viewportPoints.length) map.setViewport(viewportPoints, { margins: [55, 55, 55, 55] });
        return actualDistance;
    }

    function renderRoute(route, distance) {
        routeList.replaceChildren();
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

        const minutes = tripState.duration_minutes || Math.max(45, Math.round(distance / 75 + (route.length - 1) * 15));
        const distanceText = distance > 0 ? `约 ${(distance / 1000).toFixed(1)} km` : "步行路线";
        routeSummary.textContent = `${distanceText} · ${formatDuration(minutes)} · ${route.length - 1} 个地点`;
        routeSummary.classList.add("visible");
        document.getElementById("panel").scrollTop = 0;
    }

    function appendRouteResult(route, distance, interpretation) {
        const { bubble } = createMessageShell("assistant");
        const title = document.createElement("strong");
        const minutes = tripState.duration_minutes || Math.max(45, Math.round(distance / 75 + (route.length - 1) * 15));
        title.textContent = `路线已经生成：${route.length - 1} 站 · ${distance > 0 ? `约 ${(distance / 1000).toFixed(1)} km` : "步行路线"} · ${formatDuration(minutes)}`;
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
            line.textContent = `${index + 1}. ${stop.name}：${stop.reason}`;
            bubble.appendChild(line);
        });
        const hint = document.createElement("div");
        hint.className = "theme-note";
        hint.textContent = "你可以继续说：第二站换个近一点的、少走一点，或者点击地图地点让我讲讲。";
        bubble.appendChild(hint);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function planRoute(keywords, originalMessage, interpretation = "") {
        const usableKeywords = Array.isArray(keywords) && keywords.length ? keywords.slice(0, 4) : ["历史街区", "特色建筑"];
        const progress = appendPlanningProgress();
        progress.setStage(0);
        if (!(await ensureStartPoint())) {
            progress.fail("等待你补充起点");
            return false;
        }
        if (interpretation) renderUnderstanding({ trip_state: tripState, interpretation });

        progress.setStage(1, usableKeywords.join(" / "));
        const pois = await searchPois(usableKeywords, progress);
        if (!pois.length) {
            progress.fail("附近暂时没有搜到匹配地点");
            appendMessage("assistant", "附近暂时没有找到符合主题的地点。你可以换一个主题，或者换个起点再试。", "error");
            return false;
        }

        progress.setStage(2, `${pois.length} 个候选地点`);
        const filtered = await filterPois(pois, originalMessage);
        if (!filtered.length) {
            progress.fail("AI 没有筛到足够合适的地点");
            appendMessage("assistant", "我找到了地点，但没有足够符合这次主题的结果。换一个更具体的说法试试。", "error");
            return false;
        }

        progress.setStage(3, `从 ${filtered.length} 个地点中排路线`);
        const route = buildRoute(filtered, usableKeywords);
        if (route.length <= 1) {
            progress.fail("候选地点超出了合理步行范围");
            appendMessage("assistant", "这些地点不太适合从当前起点串成步行路线。换个更近的起点试试。", "error");
            return false;
        }

        if (tripState.end) {
            const endPoint = await geocodeAddress(tripState.end);
            if (endPoint && !route.some(stop => stop.name === tripState.end)) {
                route.push({
                    name: tripState.end,
                    point: endPoint,
                    isEnd: true,
                    keyword: "终点",
                    reason: "按你的要求把这里设为行程终点。"
                });
            }
        }

        currentRoute = route;
        currentRouteDistance = await drawRoute(currentRoute);
        renderRoute(currentRoute, currentRouteDistance);
        progress.complete();
        appendRouteResult(currentRoute, currentRouteDistance, interpretation);
        return true;
    }

    function chineseNumberToInt(value) {
        const mapNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        return /^\d+$/.test(value) ? Number(value) : mapNumbers[value] || null;
    }

    function routeTargetIndex(target, originalMessage) {
        const text = `${target || ""} ${originalMessage || ""}`;
        const namedIndex = currentRoute.findIndex((stop, index) => index > 0 && (
            text.includes(stop.name) || (target && stop.name.includes(target))
        ));
        if (namedIndex > 0) return namedIndex;
        const match = text.match(/第([一二两三四五六七八九\d]+)站/);
        const parsed = match ? chineseNumberToInt(match[1]) : null;
        if (parsed && parsed < currentRoute.length) return parsed;
        return Math.max(1, currentRoute.length - 1);
    }

    async function replaceRouteStop(index, query) {
        const genericNear = /^(更?近(?:一点)?的?|近一点儿|一个|地点)$/;
        const keyword = query && !genericNear.test(query.trim()) ? query.trim() : (currentRoute[index]?.keyword || tripState.theme?.[0] || "特色建筑");
        const candidates = await searchOneKeyword(keyword, 4000);
        const existing = new Set(currentRoute.map(stop => stop.name));
        const previousPoint = currentRoute[Math.max(0, index - 1)].point;
        const nextPoint = currentRoute[Math.min(currentRoute.length - 1, index + 1)]?.point;
        const replacement = candidates
            .filter(candidate => !existing.has(candidate.name))
            .sort((a, b) => {
                const score = candidate => haversineDistance(previousPoint, candidate.point)
                    + (nextPoint ? haversineDistance(candidate.point, nextPoint) : 0);
                return score(a) - score(b);
            })[0];
        if (!replacement) return false;
        currentRoute[index] = {
            ...replacement,
            reason: `按你的要求换成更合适的“${keyword}”地点，其他站保持不变。`
        };
        return true;
    }

    async function applyRouteModification(modification, keywords, originalMessage) {
        if (currentRoute.length <= 1) {
            appendMessage("assistant", "现在还没有可修改的路线。先告诉我起点、时长和主题，我会先生成一条。", "needs-input");
            return false;
        }

        const operation = modification?.operation || "replan";
        const index = routeTargetIndex(modification?.target, originalMessage);
        const distanceBeforeChange = currentRouteDistance;
        if (["replan", "change_theme", "extend"].includes(operation)) {
            const replanningKeywords = modification?.value ? [modification.value] : (keywords?.length ? keywords : tripState.theme);
            return planRoute(replanningKeywords, originalMessage, "我保留了当前行程背景，并按你的新要求重新安排。 ");
        }

        if (operation === "change_start") {
            const nextStart = modification?.value || tripState.start;
            const point = await geocodeAddress(nextStart);
            if (!point) {
                appendMessage("assistant", "我没有找到新的起点，请告诉我一个更具体的地标。", "error");
                return false;
            }
            await setStartPoint(point, nextStart);
            return planRoute(keywords?.length ? keywords : tripState.theme, originalMessage, "已根据新起点重新排列路线。 ");
        }

        if (operation === "change_end") {
            const nextEnd = modification?.value || tripState.end;
            const point = await geocodeAddress(nextEnd);
            if (!point) {
                appendMessage("assistant", "我没有找到新的终点，请告诉我一个更具体的地标。", "error");
                return false;
            }
            if (currentRoute.at(-1)?.isEnd) currentRoute.pop();
            currentRoute.push({
                name: nextEnd,
                point,
                isEnd: true,
                keyword: "终点",
                reason: "按你的要求把这里设为行程终点。"
            });
            currentRouteDistance = await drawRoute(currentRoute);
            renderRoute(currentRoute, currentRouteDistance);
            appendMessage("assistant", `终点已经改为“${nextEnd}”，地图路线已同步更新。`);
            return true;
        }

        let changeDescription = "路线已按你的要求更新。";
        if (operation === "shorten") {
            if (currentRoute.length <= 2) {
                appendMessage("assistant", "这已经是最短的一站路线了。你可以让我换一个更近的地点。", "needs-input");
                return false;
            }
            const removed = currentRoute.pop();
            changeDescription = `已经移除最后一站“${removed.name}”，路线更轻松了。`;
        } else if (operation === "remove_stop") {
            if (!currentRoute[index]) return false;
            const [removed] = currentRoute.splice(index, 1);
            changeDescription = `已经移除“${removed.name}”，其他地点保持不变。`;
        } else if (operation === "replace_stop") {
            const oldName = currentRoute[index]?.name;
            const replaced = await replaceRouteStop(index, modification?.value);
            if (!replaced) {
                appendMessage("assistant", "附近暂时没找到合适的替代地点。你可以告诉我想换成哪一类地点。", "error");
                return false;
            }
            changeDescription = `已经把“${oldName}”换成“${currentRoute[index].name}”，其他站保持不变。`;
        } else if (operation === "reorder") {
            const start = currentRoute[0];
            const stops = currentRoute.slice(1);
            const reordered = [];
            let cursor = start.point;
            while (stops.length) {
                stops.sort((a, b) => haversineDistance(cursor, a.point) - haversineDistance(cursor, b.point));
                const next = stops.shift();
                reordered.push(next);
                cursor = next.point;
            }
            currentRoute = [start, ...reordered];
            changeDescription = "已经按照更顺路的顺序重新排列，地点没有变化。";
        } else if (operation === "add_stop") {
            const query = modification?.value || keywords?.[0] || tripState.theme?.[0] || "特色建筑";
            const candidates = await searchOneKeyword(query, 4000);
            const existing = new Set(currentRoute.map(stop => stop.name));
            const candidate = candidates.find(item => !existing.has(item.name));
            if (!candidate) {
                appendMessage("assistant", "附近暂时没有找到可以加入的新地点。", "error");
                return false;
            }
            currentRoute.push({ ...candidate, reason: `根据你的新要求加入“${query}”主题。` });
            changeDescription = `已经加入“${candidate.name}”。`;
        } else {
            return planRoute(keywords?.length ? keywords : tripState.theme, originalMessage, "我根据你的要求重新生成了路线。 ");
        }

        currentRouteDistance = await drawRoute(currentRoute);
        if (operation === "replace_stop" && /近|少走|短/.test(originalMessage) && currentRouteDistance >= distanceBeforeChange) {
            currentRoute.splice(index, 1);
            currentRouteDistance = await drawRoute(currentRoute);
            changeDescription = "附近没有真正更近的同类替代，我先移除了这一站，保留其他路线。";
        }
        renderRoute(currentRoute, currentRouteDistance);
        appendMessage("assistant", `${changeDescription}\n现在约 ${(currentRouteDistance / 1000).toFixed(1)} km，你还可以继续用一句话调整。`);
        return true;
    }

    function askAboutPlace(stop) {
        if (isBusy) return;
        sendMessage(`介绍一下${stop.name}，并说明它为什么适合我现在这条路线`);
    }

    async function sendMessage(providedText = "") {
        const text = (providedText || chatInput.value).trim();
        if (!text || isBusy) return;
        chatInput.value = "";
        appendMessage("user", text);

        if (currentRoute.length > 1 && /(路线|一共|全程).*(多久|多长时间|多远|多少公里)/.test(text)) {
            const minutes = tripState.duration_minutes || Math.max(45, Math.round(currentRouteDistance / 75 + (currentRoute.length - 1) * 15));
            const reply = `当前路线共 ${currentRoute.length - 1} 站，步行约 ${(currentRouteDistance / 1000).toFixed(1)} km，体验时间约 ${formatDuration(minutes)}。`;
            appendMessage("assistant", reply);
            chatHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
            return;
        }

        const thinkingRow = appendMessage("assistant", "● 正在理解你的需求…");
        setBusy(true);

        try {
            const response = await fetch(apiUrl("/api/chat"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    history: chatHistory.slice(-12),
                    trip_state: tripState,
                    route_places: currentRoute.slice(1).map(stop => stop.name)
                })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            thinkingRow.remove();
            renderUnderstanding(data);

            const reply = data.reply || "我已经理解你的要求。";
            appendMessage("assistant", reply);
            let actionSummary = reply;

            const action = data.action || data.intent;
            if (action === "plan_route") {
                const planned = await planRoute(data.keywords, text, data.interpretation || reply);
                if (planned) actionSummary += "\n路线已生成。";
            } else if (action === "modify_route") {
                const modified = await applyRouteModification(data.modification, data.keywords, text);
                if (modified) actionSummary += "\n路线已更新。";
            }

            chatHistory.push({ role: "user", content: text });
            chatHistory.push({ role: "assistant", content: actionSummary });
            chatHistory = chatHistory.slice(-16);
        } catch (error) {
            thinkingRow.remove();
            appendMessage("assistant", "连接 AI 服务失败了。请确认后端已经启动，然后重试。", "error");
        } finally {
            setBusy(false);
            chatInput.focus();
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
    gpsInput.addEventListener("blur", () => setTimeout(hideGpsSuggestions, 150));
    setStartButton.addEventListener("click", setStartFromInput);

    chatInput.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    sendButton.addEventListener("click", () => sendMessage());
    document.querySelectorAll(".quick-prompt").forEach(button => {
        button.addEventListener("click", () => sendMessage(button.textContent));
    });

    initMap();
})();
