-- Up Migration
-- =====================================================================================================
-- 0014_readonly_coverage_for_businesses — Stage 6, slice 5: a business can READ its coverage and services, never change them.
--
-- 0013 gave client_services and client_service_areas one policy for every command. A business-scoped transaction could therefore have
-- INSERTed or DELETEd its own coverage rules if a dashboard query ever tried to. Coverage decides who is sold which lead, so only staff
-- (and the router/worker, which run unscoped) may write it: split each policy into "unscoped may do anything" and "a business may SELECT its own".
-- Roll-forward only.
-- =====================================================================================================
DROP POLICY client_services_tenant ON client_services;
CREATE POLICY client_services_unscoped ON client_services USING (app_client_id() IS NULL);
CREATE POLICY client_services_read_own ON client_services FOR SELECT USING (client_id = app_client_id());

DROP POLICY client_service_areas_tenant ON client_service_areas;
CREATE POLICY client_service_areas_unscoped ON client_service_areas USING (app_client_id() IS NULL);
CREATE POLICY client_service_areas_read_own ON client_service_areas FOR SELECT USING (client_id = app_client_id());
