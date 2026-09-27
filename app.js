(() => {
  const cfg = window.JOKEMOO_CONFIG || {};
  const PROJECT_ID = String(cfg.projectId || "").trim();
  const SEARCH_SECONDS = Number(cfg.searchSeconds || 60);
  const OFFLINE_AFTER_MS = Number(cfg.offlineAfterMs || 30000);
  const STATUS_CHECK_MS = Number(cfg.statusCheckMs || 10000);
  const REQUEST_POLL_MS = Number(cfg.requestPollMs || 1000);

  const DOC_BASE = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(PROJECT_ID)}/databases/(default)/documents`;
  const STATUS_URL = `${DOC_BASE}/bot_system/status`;
  const ACCOUNTS_URL = `${DOC_BASE}/bot_system/accounts`;

  const $ = id => document.getElementById(id);
  const form = $("searchForm");
  const emailInput = $("emailInput");
  const searchBtn = $("searchBtn");
  const notice = $("notice");
  const loadingCard = $("loadingCard");
  const countdown = $("countdown");
  const progressBar = $("progressBar");
  const cancelSearchBtn = $("cancelSearchBtn");
  const resultCard = $("resultCard");
  const resultTitle = $("resultTitle");
  const resultTime = $("resultTime");
  const codeBox = $("codeBox");
  const otpCode = $("otpCode");
  const copyCodeBtn = $("copyCodeBtn");
  const linkBox = $("linkBox");
  const linkPreview = $("linkPreview");
  const fullLinkPreview = $("fullLinkPreview");
  const toggleFullLinkBtn = $("toggleFullLinkBtn");
  const openLinkBtn = $("openLinkBtn");
  const copyLinkBtn = $("copyLinkBtn");
  const newSearchBtn = $("newSearchBtn");
  const footerStatus = $("footerStatus");
  const statusDot = $("statusDot");

  const botOffline = $("botOffline");
  const offlineStatusText = $("offlineStatusText");
  const offlineRetryBtn = $("offlineRetryBtn");

  const accountsBtn = $("accountsBtn");
  const accountsMiniCount = $("accountsMiniCount");
  const accountsModal = $("accountsModal");
  const accountsBackdrop = $("accountsBackdrop");
  const closeAccountsBtn = $("closeAccountsBtn");
  const refreshAccountsBtn = $("refreshAccountsBtn");
  const accountsCheckedAt = $("accountsCheckedAt");
  const accountsHealthSummary = $("accountsHealthSummary");
  const accountsList = $("accountsList");
  const readyCount = $("readyCount");
  const errorCount = $("errorCount");
  const totalCount = $("totalCount");
  const accountsSearchInput = $("accountsSearchInput");
  const clearAccountsSearchBtn = $("clearAccountsSearchBtn");
  const accountsSearchResult = $("accountsSearchResult");

  let activeRequestId = null;
  let requestStartedAt = 0;
  let requestTimer = null;
  let countdownTimer = null;
  let botOnline = false;
  let searchSerial = 0;
  const cancelledRequestIds = new Set();
  let latestAccountCount = 0;
  let accountHealthRows = [];
  let accountRealtimeTimer = null;
  const ACCOUNT_REALTIME_REFRESH_MS = 12000;

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function setNotice(message) {
    if (!message) {
      notice.textContent = "";
      hide(notice);
      return;
    }
    notice.textContent = message;
    show(notice);
  }

  function normalizeTimestamp(value) {
    if (!value) return 0;
    const normalized = String(value).replace(/\.(\d{3})\d*Z$/, ".$1Z");
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
  }

  function decodeValue(v) {
    if (!v || typeof v !== "object") return null;
    if ("stringValue" in v) return v.stringValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("timestampValue" in v) return v.timestampValue;
    if ("nullValue" in v) return null;
    if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
    return null;
  }

  function decodeFields(fields) {
    const out = {};
    for (const [key, value] of Object.entries(fields || {})) out[key] = decodeValue(value);
    return out;
  }

  function encodeFields(obj) {
    const fields = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") fields[key] = { stringValue: value };
      else if (typeof value === "boolean") fields[key] = { booleanValue: value };
      else if (Number.isInteger(value)) fields[key] = { integerValue: String(value) };
      else if (typeof value === "number") fields[key] = { doubleValue: value };
    }
    return { fields };
  }

  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
  }

  async function fetchJson(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        cache: "no-store",
        ...options,
        signal: controller.signal
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) {
        const message = data?.error?.message || `HTTP ${res.status}`;
        throw new Error(message);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function showBotOffline(message) {
    botOnline = false;
    botOffline.classList.remove("hidden");
    offlineStatusText.textContent = message || "ไม่พบบอทออนไลน์";
    footerStatus.textContent = "บอทออฟไลน์";
    statusDot.classList.add("offline");
    document.documentElement.style.overflow = "hidden";
  }

  function showBotOnline(accountCount) {
    botOnline = true;
    botOffline.classList.add("hidden");
    latestAccountCount = Number.isFinite(accountCount) ? accountCount : 0;
    const suffix = latestAccountCount ? ` · ${latestAccountCount} บัญชี` : "";
    footerStatus.textContent = `บอทออนไลน์${suffix}`;
    if (accountsMiniCount) {
      accountsMiniCount.textContent = latestAccountCount ? `${latestAccountCount} บัญชี · กดดูสถานะ` : "กดดูสถานะบัญชี";
    }
    statusDot.classList.remove("offline");
    document.documentElement.style.overflow = "";
  }

  async function checkBotStatus() {
    try {
      const doc = await fetchJson(`${STATUS_URL}?t=${Date.now()}`, {}, 5000);
      const data = decodeFields(doc.fields || {});
      const heartbeatMs = normalizeTimestamp(data.heartbeat);
      const age = heartbeatMs ? Date.now() - heartbeatMs : Infinity;
      const fresh = age >= -120000 && age <= OFFLINE_AFTER_MS;

      if (data.online === true && fresh) {
        showBotOnline(Number(data.accountCount));
        return true;
      }

      showBotOffline("บอทไม่ได้ส่งสัญญาณล่าสุด โปรดติดต่อทีมงาน");
      return false;
    } catch (err) {
      console.error("BOT STATUS ERROR", err);
      showBotOffline("ไม่สามารถเชื่อมต่อระบบสถานะบอทได้");
      return false;
    }
  }


  function formatCheckedAt(value) {
    if (!value) return "ยังไม่มีผลตรวจล่าสุด";
    const ms = normalizeTimestamp(value);
    if (!ms) return "ตรวจสอบล่าสุดแล้ว";
    try {
      return `ตรวจล่าสุด ${new Date(ms).toLocaleString("th-TH", {
        dateStyle: "short",
        timeStyle: "medium"
      })}`;
    } catch (_) {
      return "ตรวจสอบล่าสุดแล้ว";
    }
  }

  function accountStatusClass(row) {
    if (row?.status === "checking" || row?.status === "reconnecting") return "checking";
    return row?.ok === true ? "ready" : "error";
  }

  function accountStatusLabel(row) {
    if (row?.status === "checking") return "กำลังตรวจ";
    if (row?.status === "reconnecting") return "กำลังต่อใหม่";
    return row?.ok === true ? "เรียลไทม์" : "มีปัญหา";
  }


  function formatLastMailAt(value) {
    if (!value) return "ยังไม่มีข้อมูลเวลาเมลล่าสุด";
    const ms = normalizeTimestamp(value);
    if (!ms) return "ยังไม่มีข้อมูลเวลาเมลล่าสุด";
    try {
      const dt = new Date(ms);
      const now = new Date();
      const sameDay =
        dt.getFullYear() === now.getFullYear() &&
        dt.getMonth() === now.getMonth() &&
        dt.getDate() === now.getDate();

      const time = dt.toLocaleTimeString("th-TH", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });

      if (sameDay) return `เมลล่าสุดวันนี้ ${time} น.`;

      const date = dt.toLocaleDateString("th-TH", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit"
      });
      return `เมลล่าสุด ${date} ${time} น.`;
    } catch (_) {
      return "ยังไม่มีข้อมูลเวลาเมลล่าสุด";
    }
  }

  function sortAccountRows(rows) {
    return rows.sort((a, b) => {
      const aReady = a?.ok === true ? 1 : 0;
      const bReady = b?.ok === true ? 1 : 0;
      if (aReady !== bReady) return aReady - bReady;

      const aTime = normalizeTimestamp(a?.lastMailAt) || 0;
      const bTime = normalizeTimestamp(b?.lastMailAt) || 0;
      if (aTime !== bTime) return bTime - aTime;

      return String(a?.email || "").localeCompare(String(b?.email || ""));
    });
  }

  function renderFilteredAccounts() {
    const query = String(accountsSearchInput?.value || "").trim().toLowerCase();

    const filtered = !query
      ? accountHealthRows
      : accountHealthRows.filter(row =>
          String(row?.email || "").toLowerCase().includes(query) ||
          String(row?.message || "").toLowerCase().includes(query) ||
          String(accountStatusLabel(row)).toLowerCase().includes(query)
        );

    clearAccountsSearchBtn?.classList.toggle("hidden", !query);

    if (accountsSearchResult) {
      if (query) {
        accountsSearchResult.textContent = `พบ ${filtered.length} จาก ${accountHealthRows.length} บัญชี`;
        accountsSearchResult.classList.remove("hidden");
      } else {
        accountsSearchResult.textContent = "";
        accountsSearchResult.classList.add("hidden");
      }
    }

    if (!filtered.length) {
      accountsList.innerHTML = `
        <div class="accounts-empty">
          ${query ? `ไม่พบอีเมลที่ตรงกับ “${escapeHtml(query)}”` : "ยังไม่มีข้อมูลสถานะบัญชี"}
        </div>`;
      return;
    }

    accountsList.innerHTML = filtered.map(row => {
      const cls = accountStatusClass(row);
      const label = accountStatusLabel(row);
      const message = String(row?.message || (row?.ok ? "พร้อมใช้งาน" : "ตรวจสอบการตั้งค่า"));
      const email = String(row?.email || "—");
      const lastMailText = formatLastMailAt(row?.lastMailAt);

      return `
        <div class="account-health-row ${cls}">
          <span class="account-health-dot" aria-hidden="true"></span>
          <div class="account-health-copy">
            <strong>${escapeHtml(email)}</strong>
            <div class="account-health-meta">
              <span class="account-health-message">${escapeHtml(message)}</span>
              <span class="account-health-lastmail">${escapeHtml(lastMailText)}</span>
            </div>
          </div>
          <span class="account-health-badge">${escapeHtml(label)}</span>
        </div>`;
    }).join("");
  }

  function renderAccountHealth(data) {
    const rows = Array.isArray(data?.accounts) ? data.accounts.slice() : [];
    accountHealthRows = sortAccountRows(rows);

    const ready = rows.filter(row => row?.ok === true).length;
    const checking = rows.filter(row => row?.status === "checking").length;
    const error = Math.max(0, rows.length - ready - checking);

    readyCount.textContent = String(ready);
    errorCount.textContent = String(error);
    totalCount.textContent = String(rows.length || data?.accountCount || latestAccountCount || 0);

    const checkedText = data?.checking
      ? "บอทกำลังดึงสถานะและเวลาเมลล่าสุดของทุกบัญชี..."
      : formatCheckedAt(data?.checkedAt || data?.updatedAt);
    accountsCheckedAt.textContent = checkedText;

    if (accountsMiniCount) {
      const total = rows.length || data?.accountCount || latestAccountCount || 0;
      if (rows.length) {
        accountsMiniCount.textContent = `${ready}/${total} พร้อมใช้${error ? ` · ${error} เออเร่อ` : ""}`;
      } else if (total) {
        accountsMiniCount.textContent = `${total} บัญชี · กำลังตรวจ`;
      }
    }

    if (!rows.length) {
      accountHealthRows = [];
      accountsList.innerHTML = `
        <div class="accounts-empty">
          ${data?.checking ? "กำลังดึงสถานะและเวลาเมลล่าสุดของทุกบัญชี..." : "ยังไม่มีข้อมูลสถานะบัญชี"}
        </div>`;
      return;
    }

    renderFilteredAccounts();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  async function loadAccountHealth(silent = false) {
    if (!silent) {
      refreshAccountsBtn.disabled = true;
      refreshAccountsBtn.textContent = "กำลังโหลด...";
    }

    try {
      const doc = await fetchJson(`${ACCOUNTS_URL}?t=${Date.now()}`, {}, 8000);
      const data = decodeFields(doc.fields || {});
      renderAccountHealth(data);

      if (data?.realtime === true) {
        const seconds = Number(data?.pollSeconds || 5);
        accountsCheckedAt.textContent = `● LIVE · บอทตรวจกล่องเมลทุกประมาณ ${seconds} วินาที`;
        accountsCheckedAt.classList.add("live");
      } else {
        accountsCheckedAt.classList.remove("live");
      }
    } catch (err) {
      console.error("ACCOUNT HEALTH ERROR", err);

      if (!silent) {
        readyCount.textContent = "—";
        errorCount.textContent = "—";
        totalCount.textContent = String(latestAccountCount || "—");
        accountsCheckedAt.textContent = "โหลดสถานะบัญชีไม่สำเร็จ";
        accountsCheckedAt.classList.remove("live");
        accountsList.innerHTML = `
          <div class="accounts-empty error">
            ไม่สามารถอ่านสถานะอีเมลได้ กรุณาตรวจสอบ Firestore Rules
          </div>`;
      }
    } finally {
      if (!silent) {
        refreshAccountsBtn.disabled = false;
        refreshAccountsBtn.textContent = "โหลดสถานะล่าสุด";
      }
    }
  }

  function startAccountRealtime() {
    stopAccountRealtime();
    loadAccountHealth(false);
    accountRealtimeTimer = setInterval(() => {
      if (!accountsModal.classList.contains("hidden")) {
        loadAccountHealth(true);
      }
    }, ACCOUNT_REALTIME_REFRESH_MS);
  }

  function stopAccountRealtime() {
    if (accountRealtimeTimer) {
      clearInterval(accountRealtimeTimer);
      accountRealtimeTimer = null;
    }
  }

  function openAccountsModal() {
    accountsModal.classList.remove("hidden");
    document.documentElement.classList.add("modal-open");
    if (accountsSearchInput) {
      accountsSearchInput.value = "";
      clearAccountsSearchBtn?.classList.add("hidden");
      accountsSearchResult?.classList.add("hidden");
    }
    startAccountRealtime();
    setTimeout(() => accountsSearchInput?.focus(), 220);
  }

  function closeAccountsModal() {
    stopAccountRealtime();
    accountsModal.classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
  }

  function resetUI() {
    searchSerial += 1;
    activeRequestId = null;
    clearInterval(requestTimer);
    clearInterval(countdownTimer);
    requestTimer = null;
    countdownTimer = null;
    searchBtn.disabled = false;
    searchBtn.classList.remove("is-loading");
    cancelSearchBtn.disabled = false;
    hide(loadingCard);
    hide(resultCard);
    hide(codeBox);
    hide(linkBox);
    otpCode.textContent = "";
    linkPreview.textContent = "";
    resetLinkDisplay();
    openLinkBtn.href = "#";
    progressBar.style.width = "100%";
    countdown.textContent = `${SEARCH_SECONDS}s`;
  }

  function startCountdown() {
    clearInterval(countdownTimer);
    const update = () => {
      const elapsed = Math.floor((Date.now() - requestStartedAt) / 1000);
      const left = Math.max(0, SEARCH_SECONDS - elapsed);
      countdown.textContent = `${left}s`;
      progressBar.style.width = `${Math.max(0, (left / SEARCH_SECONDS) * 100)}%`;
    };
    update();
    countdownTimer = setInterval(update, 250);
  }

  async function createRequest(email) {
    const id = requestId();
    const url = `${DOC_BASE}/otp_requests?documentId=${encodeURIComponent(id)}`;
    const body = encodeFields({
      email,
      status: "pending",
      cancelled: false,
      createdAtMs: Date.now(),
      clientVersion: "github-firestore-v1"
    });

    await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, 8000);

    return id;
  }

  async function getRequest(id) {
    const doc = await fetchJson(`${DOC_BASE}/otp_requests/${encodeURIComponent(id)}?t=${Date.now()}`, {}, 6000);
    return decodeFields(doc.fields || {});
  }

  async function cancelRequest(id) {
    const url = `${DOC_BASE}/otp_requests/${encodeURIComponent(id)}?updateMask.fieldPaths=cancelled`;
    await fetchJson(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodeFields({ cancelled: true }))
    }, 6000);
  }

  function renderResult(result) {
    hide(loadingCard);
    show(resultCard);
    hide(codeBox);
    hide(linkBox);

    resultTitle.textContent = result.title || "พบข้อความแล้ว";
    resultTime.textContent = result.received_at ? `ได้รับเมื่อ ${result.received_at}` : "";

    if (result.code) {
      otpCode.textContent = String(result.code);
      show(codeBox);
    }

    if (result.url) {
      const fullUrl = String(result.url);
      linkPreview.textContent = shortenDisplayUrl(fullUrl);
      fullLinkPreview.textContent = fullUrl;
      resetLinkDisplay();
      fullLinkPreview.textContent = fullUrl;
      openLinkBtn.href = fullUrl;
      show(linkBox);
    }
  }


  function shortenDisplayUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, "");
      let path = url.pathname || "/";
      const parts = path.split("/").filter(Boolean);
      let shortPath = "";

      if (parts.length) {
        const first = parts[0];
        shortPath = "/" + (first.length > 18 ? first.slice(0, 18) + "…" : first);
        if (parts.length > 1) shortPath += "/…";
      }

      const queryHint = url.search ? "?…" : "";
      return `${host}${shortPath}${queryHint}`;
    } catch (_) {
      const value = String(rawUrl || "");
      if (value.length <= 46) return value;
      return value.slice(0, 28) + "…" + value.slice(-12);
    }
  }

  function resetLinkDisplay() {
    if (fullLinkPreview) {
      fullLinkPreview.textContent = "";
      fullLinkPreview.classList.add("hidden");
    }
    if (toggleFullLinkBtn) {
      toggleFullLinkBtn.textContent = "ดู URL เต็ม";
      toggleFullLinkBtn.setAttribute("aria-expanded", "false");
    }
  }

  function completeSearch() {
    clearInterval(requestTimer);
    clearInterval(countdownTimer);
    requestTimer = null;
    countdownTimer = null;
    searchBtn.disabled = false;
    searchBtn.classList.remove("is-loading");
    cancelSearchBtn.disabled = false;
    activeRequestId = null;
  }

  function finishCancelledSearchUI() {
    clearInterval(requestTimer);
    clearInterval(countdownTimer);
    requestTimer = null;
    countdownTimer = null;

    hide(loadingCard);
    hide(resultCard);
    hide(codeBox);
    hide(linkBox);

    searchBtn.disabled = false;
    searchBtn.classList.remove("is-loading");
    cancelSearchBtn.disabled = false;

    progressBar.style.width = "100%";
    countdown.textContent = `${SEARCH_SECONDS}s`;
    setNotice("ยกเลิกการค้นหาแล้ว");
    emailInput.focus();
  }

  async function pollActiveRequest() {
    if (!activeRequestId) return;

    const requestIdAtStart = activeRequestId;
    const serialAtStart = searchSerial;

    try {
      const data = await getRequest(requestIdAtStart);

      if (
        serialAtStart !== searchSerial ||
        requestIdAtStart !== activeRequestId ||
        cancelledRequestIds.has(requestIdAtStart)
      ) {
        return;
      }

      const status = data.status || "pending";

      if (status === "found" && data.result) {
        renderResult(data.result);
        setNotice("");
        completeSearch();
        return;
      }

      if (status === "timeout") {
        hide(loadingCard);
        setNotice(data.message || "ยังไม่พบข้อความ Netflix ภายในเวลาที่กำหนด");
        completeSearch();
        return;
      }

      if (status === "error") {
        hide(loadingCard);
        setNotice(data.message || "เกิดข้อผิดพลาดระหว่างค้นหา");
        completeSearch();
        return;
      }

      if (status === "cancelled") {
        hide(loadingCard);
        setNotice("ยกเลิกการค้นหาแล้ว");
        completeSearch();
        return;
      }

      if (Date.now() - requestStartedAt > (SEARCH_SECONDS + 20) * 1000) {
        hide(loadingCard);
        setNotice("การค้นหาใช้เวลานานเกินไป กรุณาลองใหม่");
        completeSearch();
      }
    } catch (err) {
      console.error("REQUEST POLL ERROR", err);
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const thisSearchSerial = ++searchSerial;
    setNotice("");
    hide(resultCard);

    if (!botOnline) {
      showBotOffline("ขณะนี้บอทไม่ทำงาน โปรดติดต่อทีมงาน");
      return;
    }

    const email = emailInput.value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setNotice("กรุณากรอกอีเมลให้ถูกต้อง");
      const panel = document.querySelector(".panel");
      panel?.classList.remove("input-error");
      void panel?.offsetWidth;
      panel?.classList.add("input-error");
      setTimeout(() => panel?.classList.remove("input-error"), 450);
      emailInput.focus();
      return;
    }

    searchBtn.disabled = true;
    searchBtn.classList.add("is-loading");
    try {
      const createdRequestId = await createRequest(email);

      if (thisSearchSerial !== searchSerial) {
        cancelledRequestIds.add(createdRequestId);
        cancelRequest(createdRequestId).catch(err =>
          console.warn("Late-created request cancel failed", err)
        );
        return;
      }

      activeRequestId = createdRequestId;
      requestStartedAt = Date.now();
      show(loadingCard);
      hide(resultCard);
      cancelSearchBtn.disabled = false;
      startCountdown();

      clearInterval(requestTimer);
      requestTimer = setInterval(pollActiveRequest, REQUEST_POLL_MS);
      pollActiveRequest();
    } catch (err) {
      console.error("CREATE REQUEST ERROR", err);
      searchBtn.disabled = false;
      searchBtn.classList.remove("is-loading");
      activeRequestId = null;
      setNotice("ส่งคำขอไปยังบอทไม่สำเร็จ กรุณาตรวจสอบ Firestore Rules");
    }
  });

  cancelSearchBtn.addEventListener("click", () => {
    const requestIdToCancel = activeRequestId;
    if (!requestIdToCancel) return;

    // Cancel locally at once. The user does not wait for Firestore.
    searchSerial += 1;
    cancelledRequestIds.add(requestIdToCancel);
    activeRequestId = null;
    finishCancelledSearchUI();

    // Notify bot/Firebase in the background.
    cancelRequest(requestIdToCancel)
      .catch(err => console.warn("BACKGROUND CANCEL FAILED", err))
      .finally(() => {
        setTimeout(() => cancelledRequestIds.delete(requestIdToCancel), 120000);
      });
  });

  newSearchBtn.addEventListener("click", () => {
    resetUI();
    setNotice("");
    emailInput.value = "";
    emailInput.focus();
  });


  function animateCopied(button) {
    button.classList.remove("copied");
    void button.offsetWidth;
    button.classList.add("copied");
    setTimeout(() => button.classList.remove("copied"), 520);
  }

  copyCodeBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(otpCode.textContent.trim());
      copyCodeBtn.textContent = "คัดลอกแล้ว";
      animateCopied(copyCodeBtn);
      setTimeout(() => copyCodeBtn.textContent = "คัดลอกรหัส", 1200);
    } catch (_) {
      setNotice("คัดลอกรหัสอัตโนมัติไม่ได้");
    }
  });


  toggleFullLinkBtn?.addEventListener("click", () => {
    const willShow = fullLinkPreview.classList.contains("hidden");
    fullLinkPreview.classList.toggle("hidden", !willShow);
    toggleFullLinkBtn.textContent = willShow ? "ซ่อน URL เต็ม" : "ดู URL เต็ม";
    toggleFullLinkBtn.setAttribute("aria-expanded", String(willShow));
  });

  copyLinkBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(openLinkBtn.href);
      copyLinkBtn.textContent = "คัดลอกแล้ว";
      animateCopied(copyLinkBtn);
      setTimeout(() => copyLinkBtn.textContent = "คัดลอกลิงก์", 1200);
    } catch (_) {
      setNotice("คัดลอกลิงก์อัตโนมัติไม่ได้");
    }
  });


  accountsSearchInput?.addEventListener("input", renderFilteredAccounts);
  clearAccountsSearchBtn?.addEventListener("click", () => {
    accountsSearchInput.value = "";
    renderFilteredAccounts();
    accountsSearchInput.focus();
  });

  accountsBtn?.addEventListener("click", openAccountsModal);
  closeAccountsBtn?.addEventListener("click", closeAccountsModal);
  accountsBackdrop?.addEventListener("click", closeAccountsModal);
  refreshAccountsBtn?.addEventListener("click", () => loadAccountHealth(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !accountsModal.classList.contains("hidden")) {
      closeAccountsModal();
    }
  });

  offlineRetryBtn.addEventListener("click", checkBotStatus);

  // Lock page until the first live heartbeat is confirmed.
  showBotOffline("กำลังตรวจสอบสถานะบอท...");
  checkBotStatus();
  setInterval(checkBotStatus, STATUS_CHECK_MS);
})();
