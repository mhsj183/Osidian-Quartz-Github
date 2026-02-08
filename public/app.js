(function () {
  const api = (path, opts = {}) =>
    fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...opts.headers } });

  const LOG_TYPE_LABELS = { sync: "同步", publish: "发布", "sync-and-publish": "一键同步并发布", cron: "定时任务" };
  const LOG_RESULT_LABELS = { success: "成功", fail: "失败", running: "进行中" };

  function fmtDate(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function setRunning(run) {
    document.getElementById("running").classList.toggle("hidden", !run);
    ["btn-sync", "btn-publish", "btn-sync-publish"].forEach((id) => {
      document.getElementById(id).disabled = run;
    });
  }

  function setError(el, msg) {
    const area = document.getElementById("error-area");
    if (msg) {
      area.textContent = msg;
      area.classList.remove("hidden");
    } else {
      area.classList.add("hidden");
    }
  }

  function fmtResult(success) {
    if (success === true) return "成功";
    if (success === false) return "失败";
    return "";
  }

  function refreshStatus() {
    api("/api/status")
      .then((r) => r.json())
      .then((s) => {
        const bulletinEl = document.getElementById("last-publish-bulletin");
        const bulletinText = document.getElementById("last-publish-bulletin-text");
        if (bulletinEl && bulletinText) {
          const pubTime = fmtDate(s.lastPublishAt);
          const pubResult = s.lastPublishSuccess == null ? "" : " " + fmtResult(s.lastPublishSuccess);
          bulletinText.textContent = pubTime === "-" ? "上次发布：暂无记录" : "上次发布：" + pubTime + pubResult;
          bulletinEl.className = "bulletin" + (s.lastPublishSuccess === true ? " bulletin-success" : s.lastPublishSuccess === false ? " bulletin-fail" : "");
        }

        const nextCronEl = document.getElementById("next-cron");
        if (nextCronEl) nextCronEl.textContent = s.nextCron || "-";

        const cronRes = document.getElementById("cron-result");
        if (cronRes) {
          cronRes.textContent = s.lastCronRunAt
            ? (s.lastCronSuccess === true ? "已执行" : s.lastCronSuccess === false ? "失败" : "")
            : "";
          cronRes.className = "result " + (s.lastCronSuccess === true ? "success" : s.lastCronSuccess === false ? "fail" : "");
        }

        const watcherToggle = document.getElementById("watcher-toggle");
        const watcherLabel = document.getElementById("watcher-label");
        if (watcherToggle) watcherToggle.checked = s.watcherEnabled;
        if (watcherLabel) watcherLabel.textContent = s.watcherEnabled ? "开启" : "关闭";

        setRunning(s.isRunning);

        if (s.lastSyncError || s.lastPublishError || s.lastCronError) {
          const err = [s.lastSyncError, s.lastPublishError, s.lastCronError].filter(Boolean).join("\n");
          setError(null, err);
        } else {
          setError(null, null);
        }
        refreshLogs();
      })
      .catch((e) => setError(null, "获取状态失败: " + e.message));
  }

  function doAction(endpoint, label) {
    setRunning(true);
    setError(null, null);
    api(endpoint, { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        refreshStatus();
        refreshLogs();
        if (!res.ok && res.error) setError(null, res.error);
      })
      .catch((e) => {
        setError(null, label + " 失败: " + e.message);
        refreshStatus();
        refreshLogs();
      });
  }

  document.getElementById("btn-sync").addEventListener("click", () => doAction("/api/sync", "同步"));
  document.getElementById("btn-publish").addEventListener("click", () => doAction("/api/publish", "发布"));
  document.getElementById("btn-sync-publish").addEventListener("click", () =>
    doAction("/api/sync-and-publish", "同步并发布")
  );

  const QUARTZ_PREVIEW_BASE = "/quartz-preview/";
  (function initRefreshPreview() {
    const btn = document.getElementById("btn-refresh-preview");
    const iframe = document.getElementById("quartz-preview");
    if (!btn || !iframe) return;
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "刷新中…";
      iframe.src = "about:blank";
      setTimeout(function () {
        iframe.src = QUARTZ_PREVIEW_BASE + "?t=" + Date.now();
        btn.textContent = "刷新";
        btn.disabled = false;
      }, 100);
    });
  })();

  document.getElementById("watcher-toggle").addEventListener("change", (e) => {
    api("/api/watcher", {
      method: "POST",
      body: JSON.stringify({ enabled: e.target.checked }),
    })
      .then((r) => r.json())
      .then(() => refreshStatus())
      .catch(() => refreshStatus());
  });

  function showConfigMsg(msg, isError) {
    const el = document.getElementById("config-msg");
    el.textContent = msg;
    el.className = "config-msg" + (isError ? " error" : "");
    if (msg) setTimeout(() => { el.textContent = ""; el.className = "config-msg"; }, 3000);
  }

  function loadConfig() {
    api("/api/config")
      .then((r) => r.json())
      .then((c) => {
        document.getElementById("config-obsidian").value = c.obsidianDirResolved || c.obsidianDir || "";
        document.getElementById("config-quartz").value = c.quartzContentDirResolved || c.quartzContentDir || "";
        const cronSelect = document.getElementById("config-cron-hour");
        if (cronSelect && typeof c.cronHour === "number" && c.cronHour >= 0 && c.cronHour <= 23) {
          cronSelect.value = String(Math.floor(c.cronHour));
        }
      })
      .catch(() => showConfigMsg("加载配置失败", true));
  }

  function saveCronConfig() {
    const cronSelect = document.getElementById("config-cron-hour");
    if (!cronSelect) return Promise.resolve();
    const cronHour = parseInt(cronSelect.value, 10);
    if (isNaN(cronHour) || cronHour < 0 || cronHour > 23) return Promise.resolve();
    return api("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ cronHour }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) showConfigMsg(res.error, true);
        else refreshStatus();
      })
      .catch((e) => showConfigMsg("保存失败: " + e.message, true));
  }

  function saveConfig() {
    const obsidianDir = document.getElementById("config-obsidian").value.trim();
    const quartzContentDir = document.getElementById("config-quartz").value.trim();
    if (!obsidianDir || !quartzContentDir) return Promise.resolve();
    return api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ obsidianDir, quartzContentDir }),
    })
      .then((r) => r.json().then((res) => ({ ok: r.ok, ...res })))
      .then((res) => {
        if (!res.ok && res.error) showConfigMsg(res.error, true);
        else {
          showConfigMsg("配置已保存");
          refreshStatus();
        }
      })
      .catch((e) => showConfigMsg("保存失败: " + e.message, true));
  }

  function pickDir(which) {
    const inputId = which === "quartz" ? "config-quartz" : "config-obsidian";
    const input = document.getElementById(inputId);
    api("/api/pick-dir", { method: "POST", body: JSON.stringify({ which }) })
      .then(async (r) => {
        const contentType = r.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          const text = await r.text();
          throw new Error(text.startsWith("<!") ? "接口返回了页面而非数据，请用 Dashboard 地址打开本页并重启服务（npm start）后重试" : text || "请求失败");
        }
        return r.json();
      })
      .then((res) => {
        if (res.cancelled) return;
        input.value = res.path || "";
        saveConfig();
      })
      .catch((e) => showConfigMsg("选择目录失败: " + e.message, true));
  }

  document.getElementById("btn-pick-obsidian").addEventListener("click", () => pickDir("obsidian"));
  document.getElementById("btn-pick-quartz").addEventListener("click", () => pickDir("quartz"));

  const cronSelect = document.getElementById("config-cron-hour");
  if (cronSelect) cronSelect.addEventListener("change", saveCronConfig);

  function switchTab(tabKey) {
    document.querySelectorAll(".tab").forEach((t) => {
      const isActive = t.getAttribute("data-tab") === tabKey;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive);
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      const id = p.id;
      const isActive = (id === "panel-ops" && tabKey === "ops") || (id === "panel-config" && tabKey === "config") || (id === "panel-logs" && tabKey === "logs");
      p.classList.toggle("active", isActive);
    });
    if (tabKey === "logs") refreshLogs();
  }

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.getAttribute("data-tab")));
  });

  function refreshLogs() {
    api("/api/logs")
      .then((r) => r.json())
      .then((data) => {
        const tbody = document.getElementById("logs-tbody");
        const emptyEl = document.getElementById("logs-empty");
        const logs = data.logs || [];
        if (logs.length === 0) {
          tbody.innerHTML = "";
          emptyEl.classList.remove("hidden");
          return;
        }
        emptyEl.classList.add("hidden");
        tbody.innerHTML = logs
          .map(
            (log) =>
              `<tr>
                <td>${LOG_TYPE_LABELS[log.type] || log.type}</td>
                <td>${fmtDate(log.at)}</td>
                <td class="log-result ${log.result}">${LOG_RESULT_LABELS[log.result] || log.result}</td>
              </tr>`
          )
          .join("");
      })
      .catch(() => {
        const tbody = document.getElementById("logs-tbody");
        const emptyEl = document.getElementById("logs-empty");
        tbody.innerHTML = "";
        emptyEl.textContent = "加载失败";
        emptyEl.classList.remove("hidden");
      });
  }

  loadConfig();
  refreshStatus();
  setInterval(refreshStatus, 3000);
  setInterval(refreshLogs, 3000);
})();
