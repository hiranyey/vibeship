# CLAUDE.md

## Large files

- Never read `vibeship.css` whole (about 52 KB).
  Search it with grep/Grep for the selector,
  variable or class you need, then read only
  those lines (Read with offset/limit, or
  sed -n 'X,Yp').
