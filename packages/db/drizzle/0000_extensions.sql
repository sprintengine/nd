-- PostGIS for charger locations; btree_gist so the booking exclusion
-- constraint can combine charger_id equality with slot overlap.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
