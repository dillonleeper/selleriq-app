# SellerIQ App

This is the dashboard side of SellerIQ, an ecommerce analytics project I'm building from reporting problems I've run into at work. I'm using it to explore sales, traffic, profitability, and inventory data in one place.

The related [SellerIQ repository](https://github.com/dillonleeper/SellerIQ) contains the Python ingestion scripts and warehouse SQL. The [site repository](https://github.com/dillonleeper/selleriq-site) contains the public introduction and waitlist.

## What's here

- Sales overview and period comparisons for the US and Canada.
- Product and traffic views for exploring changes by SKU and marketplace.
- Profitability views with data-completeness and reconciliation checks.
- Inventory coverage, forecasting, and reorder planning views.
- A password login and server routes for landed-cost data.

The app uses Next.js, React, TypeScript, Recharts, and Supabase/PostgreSQL. The default branch is `daily-dev`; this is ongoing work, and the calculations and views depend on the database behind it.

## Local setup

```bash
npm ci
```

Create a local `.env.local` with these variables:

| Variable | Used for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser client key |
| `AUTH_PASSWORD` | App login password |
| `AUTH_COOKIE_SECRET` | Signing the app's session cookie |
| `SUPABASE_SECRET_KEY` | Server-side database access for landed-cost routes |

Keep the password, cookie secret, and Supabase secret key on the server. Do not put them in a `NEXT_PUBLIC_` variable or commit `.env.local`.

The app expects existing marketplace data, tables, views, and RPC functions. `supabase/migrations/` contains database changes, but this repository is not a self-contained demo with a sample database. Review the SQL and its dependencies against your own database before applying it.

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000). Without the expected database and configuration, the dashboard cannot load its data.

## Development commands

- `npm run lint` — ESLint checks.
- `npm run lint:encoding` — text-encoding checks.
- `npm run build` — encoding checks followed by the Next.js build.
- `npm start` — serve a completed build.

## Notes

[`docs/multi_warehouse_notes.md`](docs/multi_warehouse_notes.md) is a backlog design note written for the weekly stable version. Its code anchors describe that version, so check the current implementation before using it as a guide.

The public code does not include the business dataset. The browser key and login screen are not substitutes for database permissions; access also depends on the configured grants, policies, and RPC functions.
