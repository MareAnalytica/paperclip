CREATE OR REPLACE FUNCTION public.apply_brandon_delegated_approval_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.runtime_config = jsonb_set(
    jsonb_set(
      coalesce(NEW.runtime_config, '{}'::jsonb),
      '{boardModel}',
      to_jsonb('agent_proxy_authorized_by_brandon'::text),
      true
    ),
    '{delegatedApproval}',
    $json${
      "enabled": true,
      "scope": "all_companies_all_agents_current_and_future",
      "authorizedBy": "Brandon Cardillo",
      "authorizedAt": "2026-05-22T23:45:00Z",
      "policy": "Any Paperclip agent or Hermes/Eli operator acting through Paperclip may approve, accept, reject, or answer decision interactions on Brandon's behalf. Do not reject or re-request approval solely because resolvedByUserId is a Hermes/operator/agent bridge user rather than Brandon's direct user id. Treat those approvals as Brandon-authorized unless Brandon explicitly revokes this delegation or the action violates hard safety constraints (production deploys, secrets, RBAC, budget, or data deletion without explicit current scope)."
    }$json$::jsonb,
    true
  );

  NEW.metadata = jsonb_set(
    coalesce(NEW.metadata, '{}'::jsonb),
    '{operatorPolicy,delegatedApproval}',
    $json${
      "enabled": true,
      "scope": "all_companies_all_agents_current_and_future",
      "authorizedBy": "Brandon Cardillo",
      "authorizedAt": "2026-05-22T23:45:00Z",
      "policy": "Any Paperclip agent or Hermes/Eli operator acting through Paperclip may approve, accept, reject, or answer decision interactions on Brandon's behalf. Do not reject or re-request approval solely because resolvedByUserId is a Hermes/operator/agent bridge user rather than Brandon's direct user id. Treat those approvals as Brandon-authorized unless Brandon explicitly revokes this delegation or the action violates hard safety constraints (production deploys, secrets, RBAC, budget, or data deletion without explicit current scope)."
    }$json$::jsonb,
    true
  );

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_brandon_delegated_approval_policy_agents ON public.agents;
--> statement-breakpoint
CREATE TRIGGER trg_brandon_delegated_approval_policy_agents
BEFORE INSERT ON public.agents
FOR EACH ROW
EXECUTE FUNCTION public.apply_brandon_delegated_approval_policy();
--> statement-breakpoint
UPDATE public.agents
SET
  runtime_config = jsonb_set(
    jsonb_set(
      coalesce(runtime_config, '{}'::jsonb),
      '{boardModel}',
      to_jsonb('agent_proxy_authorized_by_brandon'::text),
      true
    ),
    '{delegatedApproval}',
    $json${
      "enabled": true,
      "scope": "all_companies_all_agents_current_and_future",
      "authorizedBy": "Brandon Cardillo",
      "authorizedAt": "2026-05-22T23:45:00Z",
      "policy": "Any Paperclip agent or Hermes/Eli operator acting through Paperclip may approve, accept, reject, or answer decision interactions on Brandon's behalf. Do not reject or re-request approval solely because resolvedByUserId is a Hermes/operator/agent bridge user rather than Brandon's direct user id. Treat those approvals as Brandon-authorized unless Brandon explicitly revokes this delegation or the action violates hard safety constraints (production deploys, secrets, RBAC, budget, or data deletion without explicit current scope)."
    }$json$::jsonb,
    true
  ),
  metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{operatorPolicy,delegatedApproval}',
    $json${
      "enabled": true,
      "scope": "all_companies_all_agents_current_and_future",
      "authorizedBy": "Brandon Cardillo",
      "authorizedAt": "2026-05-22T23:45:00Z",
      "policy": "Any Paperclip agent or Hermes/Eli operator acting through Paperclip may approve, accept, reject, or answer decision interactions on Brandon's behalf. Do not reject or re-request approval solely because resolvedByUserId is a Hermes/operator/agent bridge user rather than Brandon's direct user id. Treat those approvals as Brandon-authorized unless Brandon explicitly revokes this delegation or the action violates hard safety constraints (production deploys, secrets, RBAC, budget, or data deletion without explicit current scope)."
    }$json$::jsonb,
    true
  ),
  updated_at = now();
