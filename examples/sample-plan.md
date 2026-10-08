# OpenWebQA sample plan

This plan exercises the demo blog app in `examples/blog/` (a zero-dependency
Node HTTP server plus a single-page browser client).

Before running, start the server first with:

    node examples/blog/server.js

It listens on http://localhost:4173/ by default. Then run this plan from the
`examples/` directory (so the demo credentials in `.openwebqa/credentials.json`
are picked up):

    cd examples
    node ../dist/cli.js sample-plan.md --agent mock

Each `## ` section is one test case; its id is the kebab-case slug of the
heading. Each case runs in its own fresh browser context (no shared
cookies/localStorage), so any case that needs a session logs in first —
`depends` only orders the cases.

Login credentials are configured in `.openwebqa/credentials.json` under the id
`qa` (the user seeded in the server) and are referenced here with
`{{credential:qa.username}}` / `{{credential:qa.password}}` placeholders; the
CLI substitutes the real values just before execution, so they never appear in
this file.

The client re-renders the post list asynchronously after a publish, and
`assertText` is a one-shot check (no retry), so the create/read cases wait
for the second post article (`#posts article:nth-of-type(2)`) — which can
only exist once the re-render has happened — before asserting.

## Load blog

- goto http://localhost:4173/
- waitForSelector #posts
- assertText h1 Demo Blog

## Login

- goto http://localhost:4173/
- fill #email {{credential:qa.username}}
- fill #password {{credential:qa.password}}
- click #login-btn
- waitForSelector #logout-btn
- assertText #status Logged in as {{credential:qa.username}}

## Logout

- goto http://localhost:4173/
- fill #email {{credential:qa.username}}
- fill #password {{credential:qa.password}}
- click #login-btn
- waitForSelector #logout-btn
- click #logout-btn
- waitForSelector #email
- assertText #status Logged out

## Create blog post

- goto http://localhost:4173/
- fill #email {{credential:qa.username}}
- fill #password {{credential:qa.password}}
- click #login-btn
- waitForSelector #post-title
- fill #post-title Hello World
- fill #post-body First post body
- click #post-submit
- waitForSelector #posts article:nth-of-type(2)
- assertText #posts Hello World

## Read blog post

- depends create-blog-post
- goto http://localhost:4173/
- waitForSelector #posts article:nth-of-type(2)
- assertText #posts Hello World
