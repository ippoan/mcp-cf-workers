# PR subscribe test

PR 購読テスト用の draft PR。

別 session が `add_issue_comment` で user-identity (yhonda-ohishi) コメントを打つ
→ 本 PR への `issue_comment` イベントが `ci-worker-probe.yml` を main 経由で発火
→ `github-actions[bot]` が wake-bell コメントを投稿
→ 購読中の本 session が `<github-webhook-activity>` で wake する、ことを確認する。

Refs: cc-relay#69 (identity-distinct wake)
