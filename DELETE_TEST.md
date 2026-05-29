# wake-bell auto-delete test

ci-worker-probe.yml の 60 秒後自動削除動作を確認するための draft PR。

別 session が本 PR にコメント → `issue_comment` トリガーで CI 発火
→ bot が wake-bell コメント投稿（本文に `_(auto-deletes in 60s)_`）
→ 60 秒経過後、bot が `DELETE /repos/.../issues/comments/{id}` で自分のコメントを消す
→ PR に bot コメントが残らないことを確認する。

Refs: cc-relay#69
