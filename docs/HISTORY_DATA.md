# 对局历史数据

服务器会默认记录所有新建房间的完整对局历史，保存位置为：

`server/history/<房间号>/<房间会话ID>/`

每个房间会话包含：

- `meta.json`：数据版本、房间配置和初始玩家信息；不会保存房间密码。
- `room.jsonl`：加入、离开、房主转交、禁言、托管和设置变更等房间级事件。
- `round_XXXX_attempt_XXXX.jsonl`：每局及流局重发的事件流。

每个对局文件的首条 `round_started` 记录四家完整初始手牌、8 张底牌、发牌算法元数据、座位、叫分顺序和规则参数。随后依次记录：

- `bid`、`reveal`、`multiply`
- `play`、`pass`
- `landlord_assigned`、`round_ended` 或 `round_aborted`

每个决策事件同时保存动作发生前的玩家观察状态，包括该玩家完整手牌、其他玩家剩余张数、上一手牌、已出牌计数、倍数、叫分记录、剩余决策时间等。`origin.source` 会区分 `human`、`bot`、`autoplay`、`timeout` 和 `auto_cannot_beat`。

文件采用 UTF-8 JSONL 格式，每行一个完整 JSON 对象，按 `sequence` 严格排序。格式版本目前为 `ddz4-expert-v1`。

可通过环境变量调整：

- `DDZ_HISTORY_DIR`：修改历史数据根目录。
- `DDZ_HISTORY_ENABLED=0`：关闭历史记录。

历史数据可能包含玩家昵称与完整隐藏牌信息，导出或共享前应按用途进行匿名化处理。
