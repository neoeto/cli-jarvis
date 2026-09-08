import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AuthConfig } from "../../config/schema.js";
import type { ConfigDraft } from "./model.js";
import {
  activeProfile,
  addProfile,
  addUnique,
  credentialSummary,
  draftChanged,
  removeAt,
  removeProfile,
  selectProfile,
  updateActiveProfile,
  validateDraft
} from "./model.js";

type Section = "profiles" | "credentials" | "web-search" | "runtime" | "security" | "external" | "extensions" | "memory" | "skills";
type Focus = "sections" | "rows";

interface Row {
  label: string;
  value?: string | undefined;
  hint?: string | undefined;
  activate?: (() => void) | undefined;
  remove?: (() => void) | undefined;
}

interface Editor {
  title: string;
  value: string;
  secret?: boolean;
  submit: (value: string) => void | Promise<void>;
}

interface Choice {
  title: string;
  choices: Array<{ label: string; run: () => void }>;
}

interface Confirmation {
  title: string;
  body: string;
  accept: () => void | Promise<void>;
}

export interface ConfigTuiAppProps {
  initial: ConfigDraft;
  onApply: (draft: ConfigDraft) => Promise<void>;
  validateExternalDirectory: (value: string) => Promise<string>;
}

const sections: Array<{ id: Section; zh: string; en: string }> = [
  { id: "profiles", zh: "模型档案", en: "Profiles" },
  { id: "credentials", zh: "凭据", en: "Credentials" },
  { id: "web-search", zh: "网络搜索", en: "Web search" },
  { id: "runtime", zh: "运行与界面", en: "Runtime & UI" },
  { id: "security", zh: "安全", en: "Security" },
  { id: "external", zh: "外部 CLI", en: "External CLI" },
  { id: "extensions", zh: "扩展", en: "Extensions" },
  { id: "memory", zh: "记忆", en: "Memory" },
  { id: "skills", zh: "Skills 信任", en: "Skills trust" }
];

function title(language: "zh-CN" | "en", zh: string, en: string): string {
  return language === "zh-CN" ? zh : en;
}

function numberValue(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function validRoot(value: string): string {
  const normalized = value.trim();
  if (!normalized || /^(?:[a-zA-Z]:[\\/]|[\\/]|\.\.(?:[\\/]|$))/.test(normalized)) {
    throw new Error("Authorization roots must be workspace-relative and cannot escape the workspace");
  }
  return normalized;
}

function masked(value: string, secret: boolean | undefined): string {
  return secret ? "•".repeat(Math.min(Math.max(value.length, 8), 32)) : value;
}

export function ConfigTuiApp({ initial, onApply, validateExternalDirectory }: ConfigTuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [rowIndex, setRowIndex] = useState(0);
  const [focus, setFocus] = useState<Focus>("sections");
  const [editor, setEditor] = useState<Editor>();
  const [choice, setChoice] = useState<Choice>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [exitChoice, setExitChoice] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);
  const language = draft.config.language;
  const section = sections[sectionIndex]?.id ?? "profiles";
  const changed = draftChanged(baseline, draft);
  const tr = (zh: string, en: string): string => title(language, zh, en);

  const openEditor = (next: Editor): void => {
    setStatus(undefined);
    setEditor(next);
  };
  const openConfirm = (next: Confirmation): void => {
    setStatus(undefined);
    setConfirmation(next);
  };
  const updateAuth = (updater: (auth: AuthConfig) => AuthConfig): void => {
    setDraft((current) => ({ ...current, auth: updater(current.auth) }));
  };
  const requestExit = (): void => {
    if (changed) {
      setExiting(true);
      setExitChoice(0);
    } else {
      exit();
    }
  };
  const apply = async (): Promise<void> => {
    const issue = validateDraft(draft);
    if (issue) {
      setStatus(`${tr("无法保存", "Cannot save")}: ${issue}`);
      return;
    }
    setSaving(true);
    setStatus(undefined);
    try {
      await onApply(draft);
      setBaseline(draft);
      exit();
    } catch (error) {
      setStatus(`${tr("保存失败", "Save failed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const profile = activeProfile(draft);
    const profileRows: Row[] = [
      ...Object.keys(draft.config.profiles).sort().map((name) => ({
        label: name,
        value: name === draft.config.activeProfile ? tr("当前", "active") : undefined,
        hint: `${draft.config.profiles[name]?.provider.id ?? ""} · ${draft.config.profiles[name]?.provider.model ?? ""}`,
        activate: () => setDraft((current) => selectProfile(current, name)),
        remove: name === draft.config.activeProfile ? undefined : () => openConfirm({
          title: tr("删除 Profile", "Remove profile"), body: name,
          accept: () => setDraft((current) => removeProfile(current, name))
        })
      })),
      { label: tr("新增 Profile", "Add profile"), value: "+", activate: () => openEditor({
        title: tr("Profile 名称", "Profile name"), value: "", submit: (value) => setDraft((current) => addProfile(current, value))
      }) },
      { label: "Provider ID", value: profile.provider.id, activate: () => openEditor({ title: "Provider ID", value: profile.provider.id, submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, provider: { ...item.provider, id: value.trim() } }))) }) },
      { label: tr("API 地址", "Base URL"), value: profile.provider.baseURL, activate: () => openEditor({ title: tr("API 地址", "Base URL"), value: profile.provider.baseURL, submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, provider: { ...item.provider, baseURL: value.trim() } }))) }) },
      { label: tr("模型", "Model"), value: profile.provider.model, activate: () => openEditor({ title: tr("模型", "Model"), value: profile.provider.model, submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, provider: { ...item.provider, model: value.trim() } }))) }) },
      { label: tr("Provider 类型", "Provider kind"), value: profile.provider.kind, activate: () => setChoice({ title: tr("Provider 类型", "Provider kind"), choices: [
        { label: "deepseek", run: () => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, provider: { ...item.provider, kind: "deepseek" } }))) },
        { label: "openai-compatible", run: () => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, provider: { ...item.provider, kind: "openai-compatible" } }))) }
      ] }) },
      { label: "Thinking", value: profile.provider.thinking ? tr("开启", "on") : tr("关闭", "off"), activate: () => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, provider: { ...item.provider, thinking: !item.provider.thinking } }))) },
      { label: tr("最大工具调用", "Max Tool calls"), value: String(profile.limits.maxToolCalls), activate: () => openEditor({ title: tr("最大工具调用", "Max Tool calls"), value: String(profile.limits.maxToolCalls), submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, limits: { ...item.limits, maxToolCalls: numberValue(value, "Max Tool calls") } }))) }) },
      { label: tr("任务超时 ms", "Task timeout ms"), value: String(profile.limits.taskTimeoutMs), activate: () => openEditor({ title: tr("任务超时 ms", "Task timeout ms"), value: String(profile.limits.taskTimeoutMs), submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, limits: { ...item.limits, taskTimeoutMs: numberValue(value, "Task timeout") } }))) }) },
      { label: tr("模型超时 ms", "Model timeout ms"), value: String(profile.limits.modelTimeoutMs), activate: () => openEditor({ title: tr("模型超时 ms", "Model timeout ms"), value: String(profile.limits.modelTimeoutMs), submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, limits: { ...item.limits, modelTimeoutMs: numberValue(value, "Model timeout") } }))) }) },
      { label: tr("工具超时 ms", "Tool timeout ms"), value: String(profile.limits.toolTimeoutMs), activate: () => openEditor({ title: tr("工具超时 ms", "Tool timeout ms"), value: String(profile.limits.toolTimeoutMs), submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, limits: { ...item.limits, toolTimeoutMs: numberValue(value, "Tool timeout") } }))) }) },
      { label: tr("最大输出字节", "Max output bytes"), value: String(profile.limits.maxOutputBytes), activate: () => openEditor({ title: tr("最大输出字节", "Max output bytes"), value: String(profile.limits.maxOutputBytes), submit: (value) => setDraft((current) => updateActiveProfile(current, (item) => ({ ...item, limits: { ...item.limits, maxOutputBytes: numberValue(value, "Max output bytes") } }))) }) }
    ];
    if (section === "profiles") return profileRows;

    if (section === "credentials") {
      const providers = [...new Set([...Object.keys(draft.config.profiles).map((name) => draft.config.profiles[name]?.provider.id ?? ""), ...Object.keys(draft.auth.providers)])].filter(Boolean).sort();
      return providers.map((provider) => ({
        label: provider,
        value: credentialSummary(draft.auth, provider, language),
        hint: tr("凭据按 Provider ID 在 Profiles 间共享", "Credentials are shared by Provider ID across profiles"),
        activate: () => setChoice({ title: provider, choices: [
          { label: tr("保留当前凭据", "Keep current credential"), run: () => undefined },
          { label: tr("替换为 API Key", "Replace with API key"), run: () => openEditor({ title: `${provider} API Key`, value: "", secret: true, submit: (value) => updateAuth((auth) => ({ ...auth, providers: { ...auth.providers, [provider]: { type: "api_key", key: value } } })) }) },
          { label: tr("使用环境变量", "Use environment variable"), run: () => openEditor({ title: tr("环境变量名", "Environment variable"), value: "", submit: (value) => {
            if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error(tr("环境变量必须为大写名称", "Environment variable must use uppercase naming"));
            updateAuth((auth) => ({ ...auth, providers: { ...auth.providers, [provider]: { type: "env", variable: value } } }));
          } }) },
          { label: tr("移除凭据", "Remove credential"), run: () => openConfirm({ title: tr("移除凭据", "Remove credential"), body: provider, accept: () => updateAuth((auth) => { const { [provider]: _removed, ...providers } = auth.providers; return { ...auth, providers }; }) }) }
        ] })
      }));
    }

    if (section === "web-search") {
      const credential = draft.auth.providers.tavily;
      return [
        {
          label: tr("启用 Tavily 网络搜索", "Enable Tavily web search"),
          value: draft.config.webSearch.enabled ? tr("开启", "on") : tr("关闭", "off"),
          hint: tr("每次搜索都会发送查询并要求确认", "Each search sends its query externally and requires confirmation"),
          activate: () => {
            if (!draft.config.webSearch.enabled && !credential) {
              setStatus(tr("请先配置 Tavily 凭据", "Configure a Tavily credential first"));
              return;
            }
            setDraft((current) => ({ ...current, config: { ...current.config, webSearch: { enabled: !current.config.webSearch.enabled } } }));
          }
        },
        {
          label: "Tavily API Key",
          value: credentialSummary(draft.auth, "tavily", language),
          hint: tr("密钥仅保存到受限 auth.json，或引用环境变量", "Store the key in protected auth.json or reference an environment variable"),
          activate: () => setChoice({ title: "Tavily API Key", choices: [
            { label: tr("保存 API Key", "Store API key"), run: () => openEditor({ title: "Tavily API Key", value: "", secret: true, submit: (value) => {
              const key = value.trim();
              if (!key) throw new Error(tr("API Key 不能为空", "API key is required"));
              updateAuth((auth) => ({ ...auth, providers: { ...auth.providers, tavily: { type: "api_key", key } } }));
            } }) },
            { label: tr("使用环境变量", "Use environment variable"), run: () => openEditor({ title: tr("环境变量名", "Environment variable"), value: credential?.type === "env" ? credential.variable : "TAVILY_API_KEY", submit: (value) => {
              const variable = value.trim();
              if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new Error(tr("环境变量必须为大写名称", "Environment variable must use uppercase naming"));
              updateAuth((auth) => ({ ...auth, providers: { ...auth.providers, tavily: { type: "env", variable } } }));
            } }) },
            { label: tr("移除凭据", "Remove credential"), run: () => openConfirm({ title: tr("移除 Tavily 凭据", "Remove Tavily credential"), body: "tavily", accept: () => updateAuth((auth) => { const { tavily: _removed, ...providers } = auth.providers; return { ...auth, providers }; }) }) }
          ] })
        }
      ];
    }

    if (section === "runtime") return [
      { label: tr("界面语言", "Display language"), value: language, activate: () => setChoice({ title: tr("界面语言", "Display language"), choices: [
        { label: "中文", run: () => setDraft((current) => ({ ...current, config: { ...current.config, language: "zh-CN" } })) },
        { label: "English", run: () => setDraft((current) => ({ ...current, config: { ...current.config, language: "en" } })) }
      ] }) },
      { label: tr("活动 Profile", "Active profile"), value: draft.config.activeProfile, hint: tr("限额在模型档案页编辑", "Edit limits on the Profiles page") }
    ];

    if (section === "security") return [
      ...draft.config.security.allowedRoots.map((root, index) => ({
        label: root,
        value: tr("授权根目录", "allowed root"),
        remove: () => openConfirm({
          title: tr("移除授权根目录", "Remove authorization root"),
          body: root,
          accept: () => setDraft((current) => ({ ...current, config: { ...current.config, security: { allowedRoots: removeAt(current.config.security.allowedRoots, index) } } }))
        })
      })),
      { label: tr("新增授权根目录", "Add authorization root"), value: "+", activate: () => openEditor({ title: tr("工作区相对路径", "Workspace-relative path"), value: "", submit: (value) => setDraft((current) => ({ ...current, config: { ...current.config, security: { allowedRoots: addUnique(current.config.security.allowedRoots, validRoot(value)) } } })) }) }
    ];

    if (section === "external") return [
      ...draft.config.externalCli.directories.map((directory, index) => ({
        label: directory,
        value: tr("已配置", "configured"),
        remove: () => openConfirm({
          title: tr("移除外部 CLI 目录", "Remove external CLI directory"),
          body: directory,
          accept: () => setDraft((current) => ({ ...current, config: { ...current.config, externalCli: { directories: removeAt(current.config.externalCli.directories, index) } } }))
        })
      })),
      { label: tr("新增外部 CLI 目录", "Add external CLI directory"), value: "+", activate: () => openEditor({ title: tr("现有目录绝对路径", "Existing directory path"), value: "", submit: async (value) => { const directory = await validateExternalDirectory(value); setDraft((current) => ({ ...current, config: { ...current.config, externalCli: { directories: addUnique(current.config.externalCli.directories, directory) } } })); } }) }
    ];

    if (section === "extensions") return [
      ...draft.config.plugins.enabled.map((name, index) => ({
        label: name,
        value: tr("已启用", "enabled"),
        remove: () => openConfirm({
          title: tr("禁用扩展", "Disable extension"),
          body: name,
          accept: () => setDraft((current) => ({ ...current, config: { ...current.config, plugins: { enabled: removeAt(current.config.plugins.enabled, index) } } }))
        })
      })),
      { label: tr("启用本地扩展", "Enable local extension"), value: "+", activate: () => openEditor({ title: tr("扩展名称", "Extension name"), value: "", submit: (value) => setDraft((current) => ({ ...current, config: { ...current.config, plugins: { enabled: addUnique(current.config.plugins.enabled, value) } } })) }) }
    ];

    if (section === "memory") return [{
      label: tr("启用本地记忆", "Enable local memory"), value: draft.config.memory.enabled ? tr("开启", "on") : tr("关闭", "off"),
      hint: tr("不管理或展示记忆内容", "Memory contents are not shown or changed here"),
      activate: () => setDraft((current) => ({ ...current, config: { ...current.config, memory: { enabled: !current.config.memory.enabled } } }))
    }];

    return [
      ...draft.config.skills.trustedWorkspaceDirectories.map((item, index) => ({
        label: item.directory,
        value: item.fingerprint.slice(0, 12),
        hint: tr("已信任的工作区 Skills", "Trusted workspace Skills"),
        remove: () => openConfirm({
          title: tr("移除 Skills 信任", "Remove Skills trust"),
          body: item.directory,
          accept: () => setDraft((current) => ({ ...current, config: { ...current.config, skills: { trustedWorkspaceDirectories: removeAt(current.config.skills.trustedWorkspaceDirectories, index) } } }))
        })
      })),
      { label: tr("提示", "Hint"), value: "cj skills trust", hint: tr("使用现有命令信任当前工作区 Skills", "Use the existing command to trust current workspace Skills") }
    ];
  }, [draft, language, section, tr, validateExternalDirectory]);

  const selectedRow = rows[Math.min(rowIndex, Math.max(0, rows.length - 1))];

  useEffect(() => {
    if (choice) setRowIndex(0);
  }, [choice]);

  useInput((input, key) => {
    if (saving) return;
    if (editor) {
      if (key.escape) { setEditor(undefined); return; }
      if (key.return) {
        void Promise.resolve(editor.submit(editor.value)).then(() => setEditor(undefined)).catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (key.backspace || key.delete) { setEditor((current) => current ? { ...current, value: current.value.slice(0, -1) } : current); return; }
      if (!key.ctrl && !key.meta && input) setEditor((current) => current ? { ...current, value: `${current.value}${input}` } : current);
      return;
    }
    if (choice) {
      if (key.escape) { setChoice(undefined); return; }
      if (key.upArrow) { setRowIndex((current) => Math.max(0, current - 1)); return; }
      if (key.downArrow) { setRowIndex((current) => Math.min(choice.choices.length - 1, current + 1)); return; }
      if (key.return) { const item = choice.choices[Math.min(rowIndex, choice.choices.length - 1)]; setChoice(undefined); setRowIndex(0); item?.run(); }
      return;
    }
    if (confirmation) {
      if (key.escape) { setConfirmation(undefined); return; }
      if (key.return) { const next = confirmation; setConfirmation(undefined); void Promise.resolve(next.accept()).catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error))); }
      return;
    }
    if (exiting) {
      const options = [tr("保存并退出", "Apply and exit"), tr("放弃改动", "Discard changes"), tr("继续编辑", "Continue editing")];
      if (key.escape) { setExiting(false); return; }
      if (key.upArrow) { setExitChoice((current) => Math.max(0, current - 1)); return; }
      if (key.downArrow) { setExitChoice((current) => Math.min(options.length - 1, current + 1)); return; }
      if (key.return) {
        if (exitChoice === 0) void apply();
        else if (exitChoice === 1) { setDraft(baseline); exit(); }
        else setExiting(false);
      }
      return;
    }
    if (key.ctrl && input.toLowerCase() === "s") { void apply(); return; }
    if (input === "q" || input === "\u0003") { requestExit(); return; }
    if (key.tab || key.leftArrow || key.rightArrow) { setFocus((current) => current === "sections" ? "rows" : "sections"); return; }
    if (key.escape) { setFocus("sections"); return; }
    if (focus === "sections") {
      if (key.upArrow) setSectionIndex((current) => Math.max(0, current - 1));
      else if (key.downArrow) setSectionIndex((current) => Math.min(sections.length - 1, current + 1));
      else if (key.return) { setFocus("rows"); setRowIndex(0); }
      return;
    }
    if (key.upArrow) { setRowIndex((current) => Math.max(0, current - 1)); return; }
    if (key.downArrow) { setRowIndex((current) => Math.min(rows.length - 1, current + 1)); return; }
    if (input === "a") { rows.find((row) => row.value === "+")?.activate?.(); return; }
    if (key.return || input === " ") { selectedRow?.activate?.(); return; }
    if (input === "d") selectedRow?.remove?.();
  });

  if (editor) {
    return <Box flexDirection="column" borderStyle="round" paddingX={1}><Text bold>{editor.title}</Text><Text>{masked(editor.value, editor.secret)}<Text color="cyan">▌</Text></Text><Text dimColor>{tr("Enter 保存 · Esc 取消", "Enter save · Esc cancel")}</Text>{status ? <Text color="red">{status}</Text> : null}</Box>;
  }
  if (choice) {
    const selected = Math.min(rowIndex, choice.choices.length - 1);
    return <Box flexDirection="column" borderStyle="round" paddingX={1}><Text bold>{choice.title}</Text>{choice.choices.map((item, index) => <Text key={item.label} color={index === selected ? "cyan" : "white"}>{index === selected ? "› " : "  "}{item.label}</Text>)}<Text dimColor>{tr("↑↓ 选择 · Enter 确认 · Esc 返回", "↑↓ select · Enter confirm · Esc back")}</Text></Box>;
  }
  if (confirmation) {
    return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}><Text bold color="yellow">{confirmation.title}</Text><Text>{confirmation.body}</Text><Text>{tr("确认此草稿改动？", "Confirm this draft change?")}</Text><Text dimColor>{tr("Enter 确认 · Esc 取消", "Enter confirm · Esc cancel")}</Text></Box>;
  }
  if (exiting) {
    const options = [tr("保存并退出", "Apply and exit"), tr("放弃改动", "Discard changes"), tr("继续编辑", "Continue editing")];
    return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}><Text bold>{tr("存在未保存改动", "Unsaved changes")}</Text>{options.map((item, index) => <Text key={item} color={index === exitChoice ? "cyan" : "white"}>{index === exitChoice ? "› " : "  "}{item}</Text>)}</Box>;
  }

  return <Box flexDirection="column" borderStyle="double" paddingX={1} width="100%">
    <Box justifyContent="space-between"><Text bold color="cyan">CJ {tr("应用配置", "Application settings")}</Text><Text color={changed ? "yellow" : "green"}>{changed ? tr("未保存", "unsaved") : tr("已保存", "saved")}</Text></Box>
    <Box marginTop={1} minHeight={18}>
      <Box flexDirection="column" width={22} borderStyle="single" paddingX={1}>{sections.map((item, index) => <Text key={item.id} color={index === sectionIndex && focus === "sections" ? "cyan" : "white"}>{index === sectionIndex ? "› " : "  "}{language === "zh-CN" ? item.zh : item.en}</Text>)}</Box>
      <Box flexDirection="column" marginLeft={2} flexGrow={1} borderStyle="single" paddingX={1}><Text bold>{language === "zh-CN" ? sections[sectionIndex]?.zh : sections[sectionIndex]?.en}</Text>{rows.map((row, index) => <Box key={`${row.label}-${index}`} flexDirection="column"><Text color={index === Math.min(rowIndex, Math.max(0, rows.length - 1)) && focus === "rows" ? "cyan" : "white"}>{index === Math.min(rowIndex, Math.max(0, rows.length - 1)) ? "› " : "  "}{row.label}{row.value ? `: ${row.value}` : ""}</Text>{row.hint ? <Text dimColor>    {row.hint}</Text> : null}</Box>)}</Box>
    </Box>
    {status ? <Text color="red">{status}</Text> : null}
    <Text dimColor>{saving ? tr("正在保存…", "Saving…") : tr("↑↓ 导航 · Tab 切换 · Enter 编辑 · d 删除 · Ctrl+S 应用 · q 退出", "↑↓ navigate · Tab switch · Enter edit · d remove · Ctrl+S apply · q quit")}</Text>
  </Box>;
}
