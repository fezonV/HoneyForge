# HoneyForge demonstration script

This is a live demonstration using synthetic data on an isolated lab. It is
not a recording of external attacks.

1. Start PostgreSQL and the control API; open the operator UI and sign in.
2. Create one Low and one Medium profile. Show service/port, banner, logging,
   channel, fake files, and synthetic credentials.
3. Create two trap instances from one profile, issue separate enrollment
   tokens, and start their agents.
4. Request the Low archive and perform a failed then successful Medium login.
   Open a synthetic file and run the allowed pseudo-command. Show the resulting
   event/session timeline in the dashboard.
5. Create revision 2, assign/apply it only to trap A, and show the changed
   banner/credentials. Confirm trap B still reports its previous applied
   revision and response.
6. Stop trap A's service while its agent remains online; show trap B still
   working. Reconnect the browser after closing WebSocket and show REST
   reconciliation.
7. Disconnect management briefly, create synthetic actions, restore the link,
   and show delivery by event IDs without duplicates.
8. Show viewer restrictions, audit entries, and the CI artifacts. State the
   remaining network/remote-host limits explicitly.
