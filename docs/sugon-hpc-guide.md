# 曙光超算 / 国家超算互联网（SCNet）接入指南

`ubuntu_hpc` 网关机已内置曙光超算驱动 [sugon-runner.js](file:///D:/ametyping/remote/agent/sugon-runner.js)，支持 **SSH + Slurm CLI** 和 **OpenAPI v2** 两种接入方式，凭据仅存于 `ubuntu_hpc` 本机 `~/.config/ame-hpc/sugon.json`（权限 `0600`），不入库、不上前端。

---

## 方式一：SSH + Slurm CLI（推荐，最通用）

1. 在 `ubuntu_hpc` 的 `~/.ssh/config` 配好免密登录（如 `Host sugon`）。
2. 创建 `~/.config/ame-hpc/sugon.json`：

```bash
mkdir -p ~/.config/ame-hpc && chmod 700 ~/.config/ame-hpc
cat > ~/.config/ame-hpc/sugon.json <<'EOF'
{
  "mode": "ssh",
  "sshHost": "sugon",
  "defaultPartition": "normal",
  "remoteWorkDir": "~/ame-hpc-jobs",
  "maxWalltime": "04:00:00"
}
EOF
chmod 600 ~/.config/ame-hpc/sugon.json
```

---

## 方式二：曙光智算 / 国家超算互联网 OpenAPI v2

若使用 `ac.sugon.com` / `scnet.cn` 的 OpenAPI（`POST /ac/openapi/v2/tokens`）：

```bash
mkdir -p ~/.config/ame-hpc && chmod 700 ~/.config/ame-hpc
cat > ~/.config/ame-hpc/sugon.json <<'EOF'
{
  "mode": "openapi",
  "baseUrl": "https://api.scnet.cn",
  "user": "你的平台用户名",
  "password": "你的平台密码",
  "orgid": "你的组织ID",
  "clusterId": "目标集群ID",
  "defaultPartition": "normal",
  "remoteWorkDir": "/public/home/你的用户名/ame-hpc-jobs",
  "maxWalltime": "04:00:00"
}
EOF
chmod 600 ~/.config/ame-hpc/sugon.json
```

---

## 生效与使用

- 保存配置后，`ubuntu_hpc` 上的 `ame-agent.service` 会在 5 分钟内自动探测并上报 `sugon-status`（也可 `systemctl --user restart ame-agent.service` 立即生效）。
- Win98 打开 **「网络与设备 › 算力与作业 (Mini-Slurm)」** 即可看到 **曙光超算（Sugon / SCNet）** 卡片点亮，支持直接提交作业、拉回产物到 `/mnt/nas/...`（直落群晖 `hpc_storage`）与一键 `scancel` 中止。
