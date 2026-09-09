(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.CitywalkRouteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // A deliberately conservative demo coverage rectangle, NOT the Xuhui
    // administrative boundary. All coordinates use the map SDK's own system.
    const DEMO_BOUNDS = Object.freeze({ west: 121.40, east: 121.49, south: 31.11, north: 31.225 });
    const GENERIC_NAMES = new Set([
        "花园", "公园", "书店", "书局", "咖啡", "咖啡店", "咖啡馆", "咖啡厅", "餐厅", "餐馆",
        "天桥", "大楼", "洋房", "老洋房", "历史建筑", "现代建筑", "地铁站", "图书馆", "广场"
    ]);
    // Explicit aliases are safe; fuzzy character matching is not (衡山 != 横山).
    const PLACE_ALIASES = Object.freeze({ "港汇": "港汇恒隆广场", "港汇恒隆": "港汇恒隆广场" });
    const CATEGORY_ALIASES = Object.freeze({
        "咖啡": "coffee", "咖啡店": "coffee", "咖啡馆": "coffee", "咖啡厅": "coffee", "coffee": "coffee", "cafe": "coffee",
        "书店": "bookstore", "书局": "bookstore", "书屋": "bookstore", "bookstore": "bookstore", "bookshop": "bookstore",
        "花园": "garden", "公园": "garden", "绿地": "garden", "garden": "garden", "park": "garden",
        "历史建筑": "heritage", "老洋房": "heritage", "洋房": "heritage", "海派建筑": "heritage", "heritage": "heritage",
        "现代建筑": "modern", "未来感建筑": "modern", "modern": "modern",
        "餐厅": "restaurant", "餐馆": "restaurant", "饭店": "restaurant", "美食": "restaurant", "restaurant": "restaurant",
        "天桥": "footbridge", "人行天桥": "footbridge", "footbridge": "footbridge"
    });
    const CATEGORY_PATTERNS = Object.freeze({
        coffee: /咖啡|coffee|caf[eé]|星巴克|manner|m\s*stand|瑞幸|皮爷|seesaw|luckin/i,
        bookstore: /书店|书局|书屋|book\s*(?:store|shop)/i,
        garden: /花园|公园|绿地|植物园|\bgarden\b|\bpark\b/i,
        heritage: /历史建筑|老洋房|洋房|故居|旧居|文物建筑|历史保护|武康大楼|罗密欧阳台|徐家汇天主教堂|\bheritage\b/i,
        modern: /现代建筑|未来感建筑|摩天楼|美罗城|港汇恒隆|徐家汇中心|光景天桥|\bmodern\b/i,
        restaurant: /餐厅|餐馆|饭店|食堂|小吃|餐饮|火锅|面馆|酒楼|料理|西餐|中餐|restaurant|bistro|brasserie/i,
        footbridge: /天桥|步行桥|人行桥|footbridge/i
    });

    function normalizeName(name) {
        if (typeof name !== "string") return "";
        let value = name.normalize("NFKC").trim().toLowerCase();
        // Remove only geographic prefixes, retaining the branch/location inside
        // parentheses so distinct branches do not become the same place.
        value = value.replace(/[\p{P}\p{S}\s]/gu, "");
        while (/^(?:上海市|上海|徐汇区|徐汇)/u.test(value)) {
            value = value.replace(/^(?:上海市|上海|徐汇区|徐汇)/u, "");
        }
        return value;
    }

    function canonicalName(name) {
        const normalized = normalizeName(name);
        return Object.prototype.hasOwnProperty.call(PLACE_ALIASES, normalized) ? PLACE_ALIASES[normalized] : normalized;
    }

    function samePlace(a, b) {
        const left = canonicalName(typeof a === "string" ? a : placeName(a));
        const right = canonicalName(typeof b === "string" ? b : placeName(b));
        if (!left || !right) return false;
        if (left === right) return true;
        const shorter = left.length <= right.length ? left : right;
        const longer = left.length > right.length ? left : right;
        if (shorter.length < 3 || GENERIC_NAMES.has(shorter)) return false;
        return longer.includes(shorter);
    }

    function placeName(poi) {
        return poi && (typeof poi.name === "string" && poi.name.trim() ? poi.name : typeof poi.title === "string" ? poi.title : "") || "";
    }

    function finiteNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    function inDemoArea(point) {
        if (!point || !finiteNumber(point.lng) || !finiteNumber(point.lat)) return false;
        return point.lng >= DEMO_BOUNDS.west && point.lng <= DEMO_BOUNDS.east
            && point.lat >= DEMO_BOUNDS.south && point.lat <= DEMO_BOUNDS.north;
    }

    function categoryText(poi) {
        if (!poi) return "";
        const flatten = value => Array.isArray(value) ? value.filter(item => typeof item === "string").join(" ")
            : typeof value === "string" ? value : "";
        // Never use keyword/search-source or the street address as evidence of
        // category: a cafe found by searching "书店" is still not a bookstore.
        return [placeName(poi), flatten(poi.tags), flatten(poi.category), flatten(poi.categories), flatten(poi.type)].join(" ");
    }

    function categoryMatches(poi, category) {
        const normalized = normalizeName(category);
        const categoryKey = Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, normalized) ? CATEGORY_ALIASES[normalized] : null;
        return Boolean(categoryKey && CATEGORY_PATTERNS[categoryKey].test(categoryText(poi)));
    }

    function matchesCatalogPlace(poi, entry) {
        if (!poi || !entry || !inDemoArea(poi.point)) return false;
        // A known brand alone must not attach one branch's tags to another.
        const names = [entry.name, ...list(entry.aliases)].map(normalizeName);
        if (!names.includes(normalizeName(placeName(poi)))) return false;
        const parseAddress = address => typeof address === "string" ? address.normalize("NFKC").replace(/\s/g, "")
            .match(/(.+?(?:路|街|大道|弄))(\d+)(?:[-—–~至](\d+))?号/) : null;
        const expected = parseAddress(entry.address);
        const actual = parseAddress(poi.address);
        // Require the catalogued street and door number from the map too.
        // Missing/ambiguous address means ordinary map result, not verified catalog.
        if (!expected || !actual || !normalizeName(actual[1]).endsWith(normalizeName(expected[1]))) return false;
        const start = Number(expected[2]), end = Number(expected[3] || expected[2]);
        return end >= start && end - start <= 100 && Number(actual[2]) >= start
            && Number(actual[3] || actual[2]) <= end;
    }

    function isUsablePoi(poi) {
        const name = placeName(poi).normalize("NFKC").trim();
        if (!name || !inDemoArea(poi && poi.point)) return false;
        if (/(?:有限公司|软件科技|物业|停车场|停车库|停车位|加油站|银行|医院|诊所|房产中介|售楼处|培训中心|瑜伽馆|办事处|写字楼|办公楼|商务楼|垃圾站|公共厕所|卫生间|快递柜|快递站|维修店)/.test(name)) return false;
        if (/(?:民宿|复式公寓|酒店式公寓|短租|日租|青年旅舍)/.test(name)) return false;
        if (/(?:停车|办公|住宅小区|住宅门牌)/.test(categoryText({ tags: poi.tags, category: poi.category, categories: poi.categories, type: poi.type }))) return false;
        // Exclude the exact failure class “横山树花园-121号”, plain addresses,
        // building numbers and apartment doors. Named sites may include their
        // address in parentheses (e.g. 历史建筑(淮海中路1768号)).
        const primaryName = name.replace(/[（(].*?[）)]/g, "").trim();
        if (/^[\d\s-]+(?:号|弄|栋|幢|室|单元)?$/.test(primaryName)) return false;
        if (/(?:[-—]\s*\d+|\d+(?:号|弄|栋|幢|室|单元))(?:\s*\d*(?:号|弄|栋|幢|室|单元))*$/.test(primaryName)) return false;
        if (/(?:出入口|停车场入口|车库入口|地下车库)$/.test(primaryName)) return false;
        return true;
    }

    function list(value) {
        return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()) : [];
    }

    function estimatedVisitMinutes(route, state) {
        const stopCount = Math.max(0, (Array.isArray(route) ? route.length : 0) - 1);
        const duration = state && state.duration_minutes;
        return stopCount * (finiteNumber(duration) && duration > 0 && duration <= 30 ? 5 : 10);
    }

    function validateRoute(route, state, metrics) {
        const requested = state || {};
        const measured = metrics || {};
        const violations = [];
        const points = Array.isArray(route) ? route : [];
        const stops = points.slice(1);
        if (points.length < 2) violations.push("尚未找到可用的游览地点。");
        if (points.length && !inDemoArea(points[0] && points[0].point)) violations.push("起点超出本 Demo 的覆盖范围，请确认上海徐汇附近的具体地点。");
        for (const poi of stops) {
            if (!isUsablePoi(poi)) violations.push(`“${placeName(poi) || "未命名地点"}”不属于可确认的 Demo 游览地点。`);
        }
        const cap = requested.max_walk_meters;
        if (finiteNumber(cap) && cap >= 0) {
            if (measured.verified !== true || !finiteNumber(measured.distance) || measured.distance < 0) {
                violations.push(`尚未取得可核验的步行距离，不能确认满足 ${cap} 米上限。`);
            } else if (measured.distance > cap) {
                violations.push(`步行约 ${Math.ceil(measured.distance)} 米，超过你要求的 ${cap} 米上限。`);
            }
        }
        for (const name of list(requested.required_places)) {
            if (!stops.some(poi => samePlace(placeName(poi), name))) violations.push(`未包含必去地点“${name}”。`);
        }
        for (const name of list(requested.excluded_places)) {
            const matching = stops.filter(poi => samePlace(placeName(poi), name) || categoryMatches(poi, name));
            if (matching.length) violations.push(`仍包含你排除的“${name}”：${matching.map(placeName).join("、")}。`);
        }
        const routeCategories = [...new Set([...list(requested.required_categories),
            ...list(requested.theme).filter(theme => /^(咖啡|咖啡馆|书店|花园|公园)$/.test(theme))])];
        for (const category of routeCategories) {
            if (!stops.some(poi => categoryMatches(poi, category))) violations.push(`路线中尚无可确认的“${category}”地点。`);
        }
        if (typeof requested.end === "string" && requested.end.trim()
            && (!stops.length || !samePlace(placeName(stops[stops.length - 1]), requested.end))) {
            violations.push(`路线尚未以“${requested.end}”作为最后一站。`);
        }
        const duration = requested.duration_minutes;
        if (finiteNumber(duration) && duration > 0 && finiteNumber(measured.walkingMinutes) && measured.walkingMinutes >= 0) {
            const total = measured.walkingMinutes + estimatedVisitMinutes(points, requested);
            if (total > duration) violations.push(`预计步行加短暂停留约 ${Math.ceil(total)} 分钟，超过你预留的 ${duration} 分钟。`);
        }
        return [...new Set(violations)];
    }

    function orderStops(route, places) {
        if (!Array.isArray(route) || !route.length) throw new Error("还没有可以调整顺序的路线。");
        if (!Array.isArray(places)) throw new Error("请明确告诉我需要调整的地点顺序。");
        const stops = route.slice(1);
        const selected = [];
        const used = new Set();
        for (const name of places) {
            if (typeof name !== "string" || !name.trim()) throw new Error("调序地点不能为空。");
            const matches = stops.map((poi, index) => ({ poi, index })).filter(item => samePlace(placeName(item.poi), name));
            if (!matches.length) throw new Error(`当前路线没有“${name}”，未修改顺序。`);
            if (matches.length > 1) throw new Error(`“${name}”对应多个地点，请说出完整名称。`);
            const match = matches[0];
            if (used.has(match.index)) throw new Error(`“${name}”重复出现，未修改顺序。`);
            used.add(match.index);
            selected.push(match.poi);
        }
        return [route[0], ...selected, ...stops.filter((_, index) => !used.has(index))];
    }

    return Object.freeze({ normalizeName, samePlace, inDemoArea, isUsablePoi, categoryMatches, matchesCatalogPlace,
        validateRoute, orderStops, estimatedVisitMinutes });
});
