# 发布到 GitHub 与 npm

本文说明如何把 `cli-jarvis` 发布为公开 GitHub 仓库和公开 npm CLI 包，使用户可以通过 `npm install -g` 安装并使用 `cj`。

## 目标

推荐使用 npm scope 发布，以避免占用全局包名的风险：

```bash
npm install -g @<npm-用户名或组织>/cli-jarvis
cj --help
```

非 scoped 包也可以发布为 `cli-jarvis`，但它位于全局命名空间，必须先确认名称可用。

```bash
npm view cli-jarvis name
```

## 发布前准备

- 注册 npm 账号；若使用组织 scope，先在 npm 创建组织或确认已加入该组织。
- 在 npm 账号中启用双因素认证。直接发布需要 2FA，或使用允许绕过 2FA 的 granular access token。
- 在 GitHub 创建一个空的 **Public** 仓库，例如 `cli-jarvis`。
- 确保工作区没有未提交的源代码变更。生成的审计报告，例如 `demo.html`，不应提交或发布。

当前项目要求 Node.js 20 或更高版本，并且已经配置好：

- `cj` 命令指向 `dist/cli/index.js`。
- `prepack` 会在打包前执行构建。
- npm 包仅会包含 `dist`、README、变更记录和 shell 补全文件等必要内容。

## 配置包元数据

编辑 `package.json`，将包名改为自己的 scope，并补充仓库链接。将尖括号替换成真实值：

```json
{
  "name": "@<npm-用户名或组织>/cli-jarvis",
  "version": "1.0.0",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/<GitHub-用户名或组织>/cli-jarvis.git"
  },
  "homepage": "https://github.com/<GitHub-用户名或组织>/cli-jarvis",
  "bugs": {
    "url": "https://github.com/<GitHub-用户名或组织>/cli-jarvis/issues"
  }
}
```

`publishConfig.access` 能避免 scoped 包首次发布时意外成为私有包。若选择非 scoped 的 `cli-jarvis` 名称，则无需该字段，也无需在发布时加 `--access public`。

## 推送公开 GitHub 仓库

GitHub 仓库公开不等于 npm 包已发布。它只公开源码，npm 仍需单独发布。

```bash
git remote add origin git@github.com:<GitHub-用户名或组织>/cli-jarvis.git
git push -u origin main

git tag v1.0.0
git push origin v1.0.0
```

如果仓库的默认分支不是 `main`，将命令中的分支名改为实际分支名。

## 检查发布包

发布前必须检查真正会上传的文件，而不仅是 Git 中的文件：

```bash
npm test
npm run typecheck
npm pack --dry-run
```

重点确认以下内容没有出现在输出中：

- `.env`、API Key、私钥、个人配置和本地审计历史；
- 构建缓存、测试输出和导出的 HTML 报告；
- 源码中不需要分发的临时文件。

可进一步创建 tarball，在临时目录验证安装效果：

```bash
npm pack
mkdir -p /tmp/cj-package-smoke-test
cd /tmp/cj-package-smoke-test
npm install /绝对路径/cli-jarvis-1.0.0.tgz
npx cj --help
```

## 首次发布到 npm

登录并确认当前 npm 身份：

```bash
npm login
npm whoami
```

发布公开 scoped 包：

```bash
npm publish --access public
```

发布非 scoped 包：

```bash
npm publish
```

发布后验证：

```bash
npm view @<npm-用户名或组织>/cli-jarvis version
npx --yes @<npm-用户名或组织>/cli-jarvis --help
```

用户安装和使用方式：

```bash
npm install -g @<npm-用户名或组织>/cli-jarvis
cj --help
```

## 后续版本发布

npm 不允许覆盖已发布的版本，因此每次发布前必须递增版本。以下命令会更新版本、创建 Git 提交和标签：

```bash
npm version patch
npm test
npm publish
git push --follow-tags
```

根据变更类型选择版本号：

- `npm version patch`：修复问题，不改变兼容 API。
- `npm version minor`：新增向后兼容的功能。
- `npm version major`：存在破坏性变更。

首次 scoped 发布需要 `npm publish --access public`。后续版本通常可直接执行 `npm publish`，因为公开访问级别已被记录。

## 推荐的 CI 发布方式

首个版本可在本机完成发布。稳定后，推荐在 GitHub Actions 中配置 npm Trusted Publishing：CI 使用 OIDC 身份证明发布，而不保存长期 npm token，并且 npm 可以生成发布来源证明。

建议的发布触发条件是推送形如 `v*` 的 Git tag；工作流至少应先执行：

```bash
npm ci
npm test
npm run typecheck
npm publish
```

请按照 npm 的 Trusted Publishing 指引，在 npm 包设置和 GitHub Actions 中绑定确切的仓库、工作流文件与发布环境后再启用。

## 官方参考

- [发布公开 scoped 包](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [发布公开非 scoped 包](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [npm scope 与访问级别](https://docs.npmjs.com/about-scopes/)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
