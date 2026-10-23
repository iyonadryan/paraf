# Example: Express + PostgreSQL

An Express API that uses Paraf for the approval of purchase requests:

- **Your tables stay yours.** `employees` and `purchase_requests` are the application's tables;
  Paraf keeps its state in the `paraf_*` tables and points at your row through the subject
  (`subject_type = 'purchase_request'`, `subject_id = purchase_requests.id`).
- **Resolvers query your data.** `role`, `supervisor`, and the `reporting-line` chain read
  `employees` when a step starts.
- **Events keep your data in sync.** `instance.completed` writes the outcome to
  `purchase_requests.status`; `approval.required` is where notifications go.
- **Paraf Studio** is mounted at `/paraf/` for editing the flow.

```sh
docker compose up -d --wait               # PostgreSQL from the repository root
pnpm install && pnpm build
pnpm --filter express-postgres start      # http://localhost:3000
```

Set `DATABASE_URL` to use another database. Try it (the `x-user` header stands in for your
login):

```sh
curl -X POST localhost:3000/purchase-requests -H 'x-user: u7' -H 'content-type: application/json' \
  -d '{"title":"Laptop","amount":25000000}'
curl localhost:3000/inbox -H 'x-user: m1'
curl -X POST localhost:3000/approvals/<instanceId>/approve -H 'x-user: m1'
curl localhost:3000/purchase-requests/<id>
```

`pnpm --filter express-postgres smoke` runs the whole story and checks it (CI does this).
