# NAS 上的 Docker 容器：一律用 compose 安装

规定（用户 2026-11-10 确认）：群晖 NAS 上的所有 Docker 容器都用 compose 文件安装和管理，不再用 `docker run` 或 Container Manager 里手动点出来的单独容器。

原因：

- 升级时 `docker compose pull && docker compose up -d` 按文件原样重建容器，端口、卷、环境变量、重启策略都不会漏。
- `docker run` 的参数只存在于容器本身，删掉重建就要从 `docker inspect` 手工还原，容易出错。
- 看板的一键升级只支持 compose 容器（靠容器上的 `com.docker.compose.project.working_dir` 标签找到目录）。

## 目录约定

每个容器一个目录，放在 `/volume2/docker/<名字>/`：

| 文件 / 目录 | 说明 |
|---|---|
| `docker-compose.yml` | 唯一的配置来源。文件头写清用途、数据在哪、怎么升级 |
| `.env` 或 `*.env` | 密钥（JWT、APP_SECRET、Web key 等），`chmod 600`，只留在 NAS 上，不进 Git |
| 数据子目录（`config/`、`db/`、`data/`…） | 用相对路径 `./xxx` 挂载，数据跟着目录走 |
| `deploy.sh`（可选） | 升级除了 pull 还要做别的事（备份、数据库迁移）时才写 |

写 compose 时：

- 设 `container_name`，名字和看板里显示、关注（📌）的一致。
- 设 `restart: unless-stopped`。
- 所有持久数据都挂到具体目录，不留匿名卷（匿名卷重建后会换成空卷）。
- 镜像默认用 `latest`；确有兼容性原因要锁版本时，在文件里注释写明原因。
- 拉镜像需要代理时用 `sudo bash ~/docker_proxy.sh on`。

## 升级

看板「网络与设备」里 compose 容器那一行有「升级」按钮，背后是 `/usr/local/bin/ame-docker-upgrade`（源码 `docker-upgrade.sh`，由 `docker-ps-sudoers.sh` 安装）：

| 情况 | 脚本做的事 |
|---|---|
| 一般容器 | `compose pull`；镜像没变就报「已是最新」不重建；变了先把旧镜像标成 `:ame-rollback`，再 `up -d`，180 秒内没正常运行就自动回退 |
| 有 `deploy.sh` 的（目前是 partdb） | 改为执行 `deploy.sh`（先备份数据库，升级后做迁移） |

结果写在 `/var/log/ame-docker-upgrade/<容器>.json` 和 `.log`，看板那一行显示结果，失败或回退会告警。

脚本以 root 运行 compose，所以只升级管理员登记过的项目，登记后 compose 文件、`.env`、`deploy.sh` 改过就拒绝：

```sh
sudo ame-docker-upgrade register /volume2/docker/<名字>    # 新装或改过 compose 文件后执行
sudo ame-docker-upgrade list
```

手动升级：`cd /volume2/docker/<名字> && sudo docker compose pull && sudo docker compose up -d`（有 `deploy.sh` 的跑它）。确认新版能用后再删旧镜像。

## 现状（2026-11-10）

| 容器 | 方式 | 目录 | 备注 |
|---|---|---|---|
| jellyfin | compose | `/volume2/docker/jellyfin/` | |
| zotero | compose | `/volume2/docker/zotero/` | 模板在仓库 `remote/deploy/nas/zotero/` |
| partdb | compose | `/volume2/docker/partdb/` | 升级走 `deploy.sh` |
| ame-onlyoffice | compose | `/volume2/docker/onlyoffice/` | 字体目录还是匿名卷（目前为空），待改成具体目录 |
| magpie | `docker run` | 数据在 `/volume1/docker/magpie/` | compose 文件已备好在 `/volume2/docker/magpie/`（与现容器逐项核对一致），待切换。它是 AI 模型网关，切换时断几秒，挑没有会话在跑时做 |
| ubuntu-1 | `docker run` | | 已退出，不再使用，待确认后清理 |
| v2raya | `docker run` | | 已退出，不再使用，待确认后清理 |

新装容器或把 `docker run` 容器转成 compose 后，更新上表。
