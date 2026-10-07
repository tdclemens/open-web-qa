# OpenWebQA sample plan

This plan exercises the demo page in `examples/demo.html`.
Each `## ` section is one test case; its id is the kebab-case slug of the heading.
Every case re-navigates to the demo page (each case runs in its own fresh
browser context); `depends` only orders the cases.

## Load home

- goto demo.html
- assertText h1 Demo App

## Enter email

- depends load-home
- goto demo.html
- fill #email test@example.com

## Submit form

- depends enter-email
- goto demo.html
- fill #email test@example.com
- click #submit
- assertText #msg Welcome test@example.com
