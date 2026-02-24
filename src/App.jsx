import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = "admin888"; // change this!

// ─── Registration window helper ───────────────────────────────────────────────
function getRegistrationStatus() {
  const now = new Date();
  const pst = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const day = pst.getUTCDay();
  const timeVal = pst.getUTCHours() + pst.getUTCMinutes() / 60;
  const isOpen =
    (day === 5 && timeVal >= 12) ||
    day === 6 ||
    (day === 0 && timeVal < 12);
  return { isOpen };
}

// ─── Time slots ───────────────────────────────────────────────────────────────
const TIME_SLOTS = [
  "北美周日晚9:30EST/6:30PST/国内周一早10:30",
  "国内周一晚6:30",
];

// ─── Group assignment (pure logic, no storage) ────────────────────────────────
function assignGroupsForPool(members) {
  let pool = members.map(m => ({ ...m }));
  let healers = pool.filter(m => m.job === "治疗");
  let commanders = pool.filter(m => m.command === "愿意");
  let semiCommanders = pool.filter(m => m.command === "半指挥");
  const proficiencyOrder = ["完全小白", "基本熟悉", "非常熟悉", "十鹅大佬"];
  const numFullTeams = Math.floor(pool.length / 10);

  if (numFullTeams === 0) {
    return { teams: [], standby: pool, warnings: [] };
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function stratifiedShuffle(arr) {
    const groups = {};
    proficiencyOrder.forEach(p => (groups[p] = []));
    arr.forEach(m => {
      if (!groups[m.proficiency]) groups[m.proficiency] = [];
      groups[m.proficiency].push(m);
    });
    proficiencyOrder.forEach(p => { groups[p] = shuffle(groups[p]); });
    const result = [];
    let changed = true;
    while (changed) {
      changed = false;
      proficiencyOrder.forEach(p => {
        if (groups[p].length > 0) { result.push(groups[p].shift()); changed = true; }
      });
    }
    return result;
  }

  const numSlots = numFullTeams + 1;
  const standbySeat = numSlots - 1;
  const teams = Array.from({ length: numSlots }, () => []);
  const used = new Set();

  // Step 2: Healers
  const shuffledHealers = shuffle(healers);
  for (let i = 0; i < numSlots && shuffledHealers.length > 0; i++) {
    const h = shuffledHealers.shift();
    teams[i].push(h); used.add(h.id);
  }
  const teamsNeedingSecondHealer = [];
  for (let i = 0; i < numFullTeams; i++) {
    if (teams[i].filter(m => m.job === "治疗").length < 2) teamsNeedingSecondHealer.push(i);
  }
  shuffle(teamsNeedingSecondHealer);
  shuffledHealers.forEach(h => {
    const standbyHealers = teams[standbySeat].filter(m => m.job === "治疗").length;
    if (standbyHealers < 2) { teams[standbySeat].push(h); used.add(h.id); }
    else if (teamsNeedingSecondHealer.length > 0) { const ti = teamsNeedingSecondHealer.shift(); teams[ti].push(h); used.add(h.id); }
    else { teams[standbySeat].push(h); used.add(h.id); }
  });

  // Step 3: Commanders (愿意 > 半指挥 > proficiency desc fallback)
  function hasCommander(team) {
    return team.some(m => m.command === "愿意" || m.command === "半指挥");
  }
  const availableWilling = shuffle(commanders.filter(m => !used.has(m.id)));
  const availableSemi = shuffle(semiCommanders.filter(m => !used.has(m.id)));
  const proficiencyDesc = [...proficiencyOrder].reverse();

  function assignCommanderToSlot(i) {
    if (hasCommander(teams[i])) return;
    if (availableWilling.length > 0) {
      const c = availableWilling.shift(); teams[i].push(c); used.add(c.id);
    } else if (availableSemi.length > 0) {
      const c = availableSemi.shift(); teams[i].push(c); used.add(c.id);
    } else {
      for (const prof of proficiencyDesc) {
        const candidate = pool.find(m => !used.has(m.id) && m.proficiency === prof);
        if (candidate) { teams[i].push(candidate); used.add(candidate.id); break; }
      }
    }
  }
  for (let i = 0; i < numSlots; i++) assignCommanderToSlot(i);
  [...availableWilling, ...availableSemi].forEach(c => {
    if (!used.has(c.id)) { teams[standbySeat].push(c); used.add(c.id); }
  });

  // Step 4: Fill remaining with stratified sampling
  const remaining = stratifiedShuffle(pool.filter(m => !used.has(m.id)));
  for (let i = 0; i < numFullTeams; i++) {
    while (teams[i].length < 10 && remaining.length > 0) {
      const m = remaining.shift(); teams[i].push(m); used.add(m.id);
    }
  }
  remaining.forEach(m => { teams[standbySeat].push(m); used.add(m.id); });

  // Step 5: Warnings
  const warnings = [];
  for (let i = 0; i < numFullTeams; i++) {
    if (teams[i].filter(m => m.ip === "国内").length < 2)
      warnings.push({ teamIndex: i, type: "缺少国内老师" });
  }
  if (teams[standbySeat].length > 0 && teams[standbySeat].filter(m => m.ip === "国内").length < 2)
    warnings.push({ teamIndex: standbySeat, type: "缺少国内老师" });

  return { teams: teams.slice(0, numFullTeams), standby: teams[standbySeat], warnings };
}

function assignGroups(members) {
  const byTime = {};
  TIME_SLOTS.forEach(t => { byTime[t] = []; });
  members.forEach(m => { if (!byTime[m.time]) byTime[m.time] = []; byTime[m.time].push(m); });

  const slots = TIME_SLOTS.map(timeSlot => {
    const result = assignGroupsForPool(byTime[timeSlot] || []);
    return { timeSlot, ...result };
  }).filter(s => s.teams.length > 0 || s.standby.length > 0);

  const allWarnings = slots.flatMap(s => s.warnings.map(w => ({ ...w, timeSlot: s.timeSlot })));
  return { slots, allWarnings };
}

// ─── Constants ────────────────────────────────────────────────────────────────
const jobColors = { "近战": "#f97316", "远程": "#3b82f6", "治疗": "#22c55e" };
const proficiencyEmoji = { "完全小白": "🌱", "基本熟悉": "⚔️", "非常熟悉": "🔥", "十鹅大佬": "👑" };

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("register");
  const [registrations, setRegistrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adminOverride, setAdminOverride] = useState(null);
  const [form, setForm] = useState({
    id: "", job: "近战", command: "不愿意",
    proficiency: "基本熟悉", ip: "北美",
    time: "北美周日晚9:30EST/6:30PST/国内周一早10:30",
  });
  const [submitted, setSubmitted] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [groupResult, setGroupResult] = useState(null);
  const [notification, setNotification] = useState("");
  const [saving, setSaving] = useState(false);

  const { isOpen: autoOpen } = getRegistrationStatus();
  const isOpen = adminOverride === "open" ? true : adminOverride === "closed" ? false : autoOpen;

  // ── Load data from Supabase on mount ────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const { data: regs } = await supabase
          .from("registrations")
          .select("*")
          .order("created_at", { ascending: true });
        if (regs) setRegistrations(regs);
      } catch (e) { console.error(e); }

      try {
        const { data: setting } = await supabase
          .from("settings")
          .select("value")
          .eq("key", "reg_override")
          .single();
        if (setting) setAdminOverride(setting.value || null);
      } catch (e) { /* setting row may not exist yet */ }

      setLoading(false);
    }
    load();

    // ── Real-time subscription: registrations update live ──────────────────
    const channel = supabase
      .channel("registrations-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "registrations" }, () => {
        supabase.from("registrations").select("*").order("created_at", { ascending: true })
          .then(({ data }) => { if (data) setRegistrations(data); });
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  // ── Notify helper ──────────────────────────────────────────────────────────
  function notify(msg) {
    setNotification(msg);
    setTimeout(() => setNotification(""), 3000);
  }

  // ── Submit registration ────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!form.id.trim()) { notify("请填写ID"); return; }
    setSaving(true);
    const { error } = await supabase.from("registrations").upsert(
      { ...form, id: form.id.trim() },
      { onConflict: "id" }
    );
    setSaving(false);
    if (error) { notify("提交失败：" + error.message); return; }
    setSubmitted(true);
    notify("注册成功！");
  }

  // ── Admin: set registration window override ────────────────────────────────
  async function handleSetOverride(value) {
    setAdminOverride(value);
    if (value === null) {
      await supabase.from("settings").delete().eq("key", "reg_override");
    } else {
      await supabase.from("settings").upsert({ key: "reg_override", value }, { onConflict: "key" });
    }
    notify(value === "open" ? "✅ 报名已强制开放" : value === "closed" ? "🔒 报名已强制关闭" : "🔄 已恢复自动时间控制");
  }

  // ── Admin: delete a member ─────────────────────────────────────────────────
  async function handleDeleteMember(id) {
    const { error } = await supabase.from("registrations").delete().eq("id", id);
    if (!error) notify(`已删除 ${id}`);
    else notify("删除失败：" + error.message);
  }

  // ── Admin: clear all registrations ────────────────────────────────────────
  async function handleClearAll() {
    if (!window.confirm("确定要清空所有报名数据吗？")) return;
    await supabase.from("registrations").delete().neq("id", "___never___");
    setRegistrations([]);
    setGroupResult(null);
    notify("已清空");
  }

  // ── Assign groups ──────────────────────────────────────────────────────────
  function handleAssign() {
    setGroupResult(assignGroups(registrations));
    setView("results");
  }

  const hasWarning = (timeSlot, teamIndex) =>
    groupResult?.allWarnings.some(w => w.timeSlot === timeSlot && w.teamIndex === teamIndex);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ ...styles.root, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", color: "#64748b" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚔️</div>
          <div>加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.bgDeco1} />
      <div style={styles.bgDeco2} />

      {notification && <div style={styles.notification}>{notification}</div>}

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <div style={styles.logo}>【曲项向天歌】十人本报名</div>
            <div style={styles.logoSub}>每周组队报名系统</div>
          </div>
          <nav style={styles.nav}>
            <button style={view === "register" ? styles.navBtnActive : styles.navBtn} onClick={() => setView("register")}>报名</button>
            <button style={view === "admin" ? styles.navBtnActive : styles.navBtn} onClick={() => setView("admin")}>管理员</button>
            {groupResult && (
              <button style={view === "results" ? styles.navBtnActive : styles.navBtn} onClick={() => setView("results")}>分组结果</button>
            )}
          </nav>
        </div>
      </header>

      <main style={styles.main}>

        {/* ── REGISTER ── */}
        {view === "register" && (
          <div style={styles.card}>
            <div style={styles.statusBadge(isOpen)}>
              {isOpen ? "🟢 报名开放中" : "🔴 报名未开放"}
            </div>
            <p style={styles.statusNote}>
              {adminOverride === "open" ? "⚡ 管理员已手动开放报名"
                : adminOverride === "closed" ? "⚡ 管理员已手动关闭报名"
                : isOpen ? "报名窗口：每周五12:00 PST 至 周日12:00 PST"
                : "报名窗口：每周五12:00 PST 开放，周日12:00 PST 截止"}
            </p>

            {!submitted ? (
              <>
                <div style={styles.formGrid}>
                  <FormField label="ID（游戏内名字）">
                    <input style={styles.input} value={form.id}
                      onChange={e => setForm({ ...form, id: e.target.value })}
                      placeholder="请输入游戏ID" disabled={!isOpen} />
                  </FormField>
                  <FormField label="职业">
                    <Select value={form.job} onChange={v => setForm({ ...form, job: v })}
                      disabled={!isOpen} options={["近战", "远程", "治疗"]} />
                  </FormField>
                  <FormField label="愿意指挥">
                    <Select value={form.command} onChange={v => setForm({ ...form, command: v })}
                      disabled={!isOpen} options={["愿意", "不愿意", "半指挥"]} />
                  </FormField>
                  <FormField label="副本熟悉程度">
                    <Select value={form.proficiency} onChange={v => setForm({ ...form, proficiency: v })}
                      disabled={!isOpen} options={["完全小白", "基本熟悉", "非常熟悉", "十鹅大佬"]} />
                  </FormField>
                  <FormField label="IP地址">
                    <Select value={form.ip} onChange={v => setForm({ ...form, ip: v })}
                      disabled={!isOpen} options={["北美", "国内", "其他"]} />
                  </FormField>
                  <FormField label="副本时间">
                    <Select value={form.time} onChange={v => setForm({ ...form, time: v })}
                      disabled={!isOpen} options={TIME_SLOTS} />
                  </FormField>
                </div>
                <button style={{ ...styles.btnPrimary, opacity: saving ? 0.7 : 1 }}
                  onClick={handleSubmit} disabled={!isOpen || saving}>
                  {saving ? "提交中..." : isOpen ? "提交报名 →" : "报名未开放"}
                </button>
                {registrations.length > 0 && (
                  <p style={styles.hint}>当前已报名：{registrations.length} 人</p>
                )}
              </>
            ) : (
              <div style={styles.successBox}>
                <div style={{ fontSize: 48 }}>🎉</div>
                <h2 style={{ color: "#22c55e", margin: "8px 0" }}>报名成功！</h2>
                <p style={{ color: "#94a3b8" }}>ID: <strong style={{ color: "#f1f5f9" }}>{form.id}</strong></p>
                <p style={{ color: "#94a3b8" }}>职业: <strong style={{ color: jobColors[form.job] }}>{form.job}</strong></p>
                <p style={{ color: "#94a3b8" }}>当前总报名人数: {registrations.length}</p>
                <button style={{ ...styles.btnSecondary, marginTop: 16 }} onClick={() => {
                  setSubmitted(false);
                  setForm({ id: "", job: "近战", command: "不愿意", proficiency: "基本熟悉", ip: "北美", time: TIME_SLOTS[0] });
                }}>再次报名（其他人）</button>
              </div>
            )}
          </div>
        )}

        {/* ── ADMIN ── */}
        {view === "admin" && (
          <div style={styles.card}>
            {!adminAuthed ? (
              <div style={styles.adminLogin}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>🔐</div>
                <h2 style={styles.cardTitle}>管理员登录</h2>
                <input style={styles.input} type="password" placeholder="请输入管理员密码"
                  value={adminPass} onChange={e => setAdminPass(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && (adminPass === ADMIN_PASSWORD ? (setAdminAuthed(true), setAdminError("")) : setAdminError("密码错误"))} />
                {adminError && <p style={{ color: "#ef4444", marginTop: 8 }}>{adminError}</p>}
                <button style={{ ...styles.btnPrimary, marginTop: 16 }} onClick={() => {
                  adminPass === ADMIN_PASSWORD ? (setAdminAuthed(true), setAdminError("")) : setAdminError("密码错误");
                }}>登录</button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                  <h2 style={styles.cardTitle}>管理员面板</h2>
                  <span style={{ color: "#22c55e", fontSize: 14 }}>✓ 已登录</span>
                </div>

                {/* Window override */}
                <div style={styles.overrideBox}>
                  <div style={{ marginBottom: 10 }}>
                    <span style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 14 }}>📅 报名窗口控制</span>
                    <span style={{
                      marginLeft: 10, fontSize: 12, padding: "2px 10px", borderRadius: 12,
                      background: isOpen ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                      color: isOpen ? "#22c55e" : "#ef4444",
                      border: `1px solid ${isOpen ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                    }}>
                      当前状态：{isOpen ? "开放中" : "已关闭"}
                      {adminOverride ? `（管理员${adminOverride === "open" ? "强制开放" : "强制关闭"}）` : "（自动）"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {[
                      { val: "open", label: "🟢 强制开放报名", activeStyle: styles.btnOverrideActiveGreen },
                      { val: "closed", label: "🔴 强制关闭报名", activeStyle: styles.btnOverrideActiveRed },
                      { val: null, label: "🔄 恢复自动时间", activeStyle: styles.btnOverrideActiveGray },
                    ].map(({ val, label, activeStyle }) => (
                      <button key={String(val)}
                        style={{ ...styles.btnOverride, ...(adminOverride === val ? activeStyle : {}) }}
                        onClick={() => handleSetOverride(val)}>{label}</button>
                    ))}
                  </div>
                </div>

                {/* Stats */}
                <div style={styles.adminStats}>
                  <StatBox label="总报名" value={registrations.length} />
                  <StatBox label="可组队数" value={Math.floor(registrations.length / 10) * 10} />
                  <StatBox label="候补人数" value={registrations.length % 10} />
                  <StatBox label="完整队伍" value={Math.floor(registrations.length / 10)} />
                </div>

                <div style={{ display: "flex", gap: 12, margin: "24px 0" }}>
                  <button style={styles.btnPrimary} onClick={handleAssign} disabled={registrations.length < 1}>
                    🎲 开始随机分组
                  </button>
                  <button style={styles.btnDanger} onClick={handleClearAll}>
                    🗑 清空报名
                  </button>
                </div>

                {/* Member list */}
                {registrations.length > 0 && (
                  <div>
                    <h3 style={{ color: "#94a3b8", fontSize: 14, marginBottom: 12 }}>报名名单（{registrations.length}人）</h3>
                    <div style={styles.memberTable}>
                      <div style={styles.tableHeader}>
                        <span>ID</span><span>职业</span><span>指挥</span><span>熟悉度</span><span>IP</span><span>操作</span>
                      </div>
                      {registrations.map(r => (
                        <div key={r.id} style={styles.tableRow}>
                          <span style={{ color: "#f1f5f9", fontWeight: 600 }}>{r.id}</span>
                          <span style={{ color: jobColors[r.job] }}>{r.job}</span>
                          <span style={{ color: r.command === "愿意" ? "#f59e0b" : r.command === "半指挥" ? "#a78bfa" : "#64748b" }}>{r.command}</span>
                          <span>{proficiencyEmoji[r.proficiency]} {r.proficiency}</span>
                          <span style={{ color: r.ip === "国内" ? "#22c55e" : "#64748b" }}>{r.ip}</span>
                          <button style={styles.btnTiny} onClick={() => handleDeleteMember(r.id)}>删除</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── RESULTS ── */}
        {view === "results" && groupResult && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <h2 style={{ ...styles.cardTitle, margin: 0 }}>分组结果</h2>
              <button style={styles.btnSecondary} onClick={handleAssign}>🔄 重新分组</button>
            </div>

            {groupResult.allWarnings.length > 0 && (
              <div style={styles.warningBanner}>
                ⚠️ 注意：{groupResult.allWarnings.length} 个队伍存在警告
              </div>
            )}

            {groupResult.slots.map(slot => (
              <div key={slot.timeSlot} style={styles.timeSlotSection}>
                <div style={styles.timeSlotHeader}>
                  <span style={styles.timeSlotTitle}>🕙 {slot.timeSlot}</span>
                  <span style={styles.timeSlotCount}>
                    {slot.teams.reduce((a, t) => a + t.length, 0) + slot.standby.length} 人 · {slot.teams.length} 队
                  </span>
                </div>
                <div style={styles.teamsGrid}>
                  {slot.teams.map((team, i) => (
                    <TeamCard key={i} team={team} label={`队伍 ${i + 1}`}
                      warning={hasWarning(slot.timeSlot, i)} isStandby={false} />
                  ))}
                  {slot.standby.length > 0 && (
                    <TeamCard team={slot.standby} label="候补"
                      warning={hasWarning(slot.timeSlot, slot.teams.length)} isStandby={true} />
                  )}
                </div>
              </div>
            ))}

            {groupResult.slots.length === 0 && (
              <div style={{ color: "#64748b", textAlign: "center", padding: 40 }}>暂无报名数据</div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function TeamCard({ team, label, warning, isStandby }) {
  const commander = team.find(m => m.command === "愿意" || m.command === "半指挥");
  return (
    <div style={{ ...styles.teamCard, ...(isStandby ? styles.standbyCard : {}), ...(warning ? styles.warningCard : {}) }}>
      <div style={styles.teamHeader}>
        <span style={{ fontWeight: 700, fontSize: 16, color: isStandby ? "#f59e0b" : "#f1f5f9" }}>
          {isStandby ? "🔶" : "⚔️"} {label}
        </span>
        <span style={{ fontSize: 13, color: "#64748b" }}>{team.length}人</span>
      </div>
      {warning && <div style={styles.warningTag}>⚠️ 缺少国内老师</div>}
      <div style={styles.teamMeta}>
        {commander
          ? <span style={styles.metaTag("#f59e0b")}>👑 指挥: {commander.id}{commander.command === "半指挥" ? " (半)" : ""}</span>
          : <span style={styles.metaTag("#ef4444")}>⚠️ 无指挥</span>}
      </div>
      <div style={styles.memberList}>
        {team.map(m => (
          <div key={m.id} style={styles.memberRow}>
            <span style={{ fontSize: 14 }}>{m.job === "治疗" ? "💚" : m.job === "近战" ? "🗡️" : "🏹"}</span>
            <span style={{ flex: 1, color: "#f1f5f9", fontSize: 14 }}>{m.id}</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: m.ip === "国内" ? "#22c55e" : m.ip === "北美" ? "#60a5fa" : "#94a3b8" }}>{m.ip}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ color: "#94a3b8", fontSize: 13, fontWeight: 600 }}>{label}</label>
      {children}
    </div>
  );
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select style={{ ...styles.input, cursor: disabled ? "not-allowed" : "pointer" }}
      value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function StatBox({ label, value }) {
  return (
    <div style={styles.statBox}>
      <div style={{ fontSize: 28, fontWeight: 700, color: "#f1f5f9" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#64748b" }}>{label}</div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  root: { minHeight: "100vh", background: "#0a0f1e", fontFamily: "'Noto Sans SC','PingFang SC',sans-serif", color: "#f1f5f9", position: "relative", overflow: "hidden" },
  bgDeco1: { position: "fixed", top: -200, right: -200, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle,rgba(59,130,246,0.08) 0%,transparent 70%)", pointerEvents: "none" },
  bgDeco2: { position: "fixed", bottom: -200, left: -200, width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle,rgba(34,197,94,0.06) 0%,transparent 70%)", pointerEvents: "none" },
  notification: { position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 24px", color: "#f1f5f9", zIndex: 1000, boxShadow: "0 4px 24px rgba(0,0,0,0.5)" },
  header: { borderBottom: "1px solid #1e293b", background: "rgba(10,15,30,0.9)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 },
  headerInner: { maxWidth: 1100, margin: "0 auto", padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  logo: { fontSize: 20, fontWeight: 700, color: "#f1f5f9" },
  logoSub: { fontSize: 12, color: "#475569", marginTop: 2 },
  nav: { display: "flex", gap: 8 },
  navBtn: { background: "transparent", border: "1px solid #1e293b", borderRadius: 6, color: "#64748b", padding: "6px 16px", cursor: "pointer", fontSize: 14 },
  navBtnActive: { background: "#1e293b", border: "1px solid #334155", borderRadius: 6, color: "#f1f5f9", padding: "6px 16px", cursor: "pointer", fontSize: 14 },
  main: { maxWidth: 1100, margin: "0 auto", padding: "32px 24px" },
  card: { background: "#0f172a", border: "1px solid #1e293b", borderRadius: 16, padding: "32px", maxWidth: 640, margin: "0 auto" },
  cardTitle: { fontSize: 20, fontWeight: 700, color: "#f1f5f9", marginBottom: 24 },
  statusBadge: (o) => ({ display: "inline-block", background: o ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: o ? "#22c55e" : "#ef4444", border: `1px solid ${o ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`, borderRadius: 20, padding: "4px 14px", fontSize: 13, fontWeight: 600, marginBottom: 8 }),
  statusNote: { color: "#475569", fontSize: 13, marginBottom: 24 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 },
  input: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#f1f5f9", padding: "10px 14px", fontSize: 14, width: "100%", boxSizing: "border-box", outline: "none" },
  btnPrimary: { background: "linear-gradient(135deg,#3b82f6,#2563eb)", border: "none", borderRadius: 8, color: "white", padding: "12px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer", width: "100%" },
  btnSecondary: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#f1f5f9", padding: "10px 20px", fontSize: 14, cursor: "pointer" },
  btnDanger: { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#ef4444", padding: "12px 20px", fontSize: 14, cursor: "pointer" },
  btnTiny: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 4, color: "#ef4444", padding: "2px 8px", fontSize: 12, cursor: "pointer" },
  hint: { color: "#475569", fontSize: 13, textAlign: "center", marginTop: 12 },
  successBox: { textAlign: "center", padding: "32px 0" },
  adminLogin: { textAlign: "center", maxWidth: 320, margin: "0 auto", padding: "32px 0" },
  adminStats: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 },
  statBox: { background: "#1e293b", borderRadius: 10, padding: "16px", textAlign: "center" },
  memberTable: { border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" },
  tableHeader: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr 2fr 1fr 1fr", padding: "10px 16px", background: "#1e293b", color: "#64748b", fontSize: 12, fontWeight: 600 },
  tableRow: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr 2fr 1fr 1fr", padding: "10px 16px", borderTop: "1px solid #1e293b", fontSize: 13, alignItems: "center", color: "#94a3b8" },
  teamsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 16 },
  teamCard: { background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: "20px" },
  standbyCard: { border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.03)" },
  warningCard: { border: "1px solid rgba(239,68,68,0.4)" },
  teamHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  warningTag: { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, color: "#ef4444", fontSize: 12, padding: "4px 10px", marginBottom: 10, display: "inline-block" },
  teamMeta: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  metaTag: (color) => ({ background: `${color}20`, border: `1px solid ${color}40`, borderRadius: 4, color, fontSize: 11, padding: "2px 8px" }),
  memberList: { display: "flex", flexDirection: "column", gap: 4 },
  memberRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #1e293b" },
  warningBanner: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#ef4444", padding: "12px 20px", marginBottom: 20, fontSize: 14 },
  timeSlotSection: { marginBottom: 40 },
  timeSlotHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 12, borderBottom: "2px solid #1e293b" },
  timeSlotTitle: { fontSize: 17, fontWeight: 700, color: "#c7d2fe", letterSpacing: "-0.3px" },
  timeSlotCount: { fontSize: 13, color: "#475569" },
  overrideBox: { background: "#1e293b", border: "1px solid #334155", borderRadius: 10, padding: "16px 20px", marginBottom: 24 },
  btnOverride: { background: "transparent", border: "1px solid #334155", borderRadius: 6, color: "#64748b", padding: "7px 14px", fontSize: 13, cursor: "pointer" },
  btnOverrideActiveGreen: { background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.4)", color: "#22c55e" },
  btnOverrideActiveRed: { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", color: "#ef4444" },
  btnOverrideActiveGray: { background: "rgba(148,163,184,0.15)", border: "1px solid rgba(148,163,184,0.4)", color: "#94a3b8" },
};
