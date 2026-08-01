export function createConsumeGrantUseStatement(db?: any) : any {
  return db.prepare(`
    UPDATE tool_grants
    SET use_count = use_count + 1,
        last_used_at = ?
    WHERE id = ?
      AND token_hash = ?
      AND updated_at = ?
      AND enabled = 1
      AND revoked_at = ''
      AND EXISTS (
        SELECT 1 FROM tool_grant_owners AS owner
        WHERE owner.grant_id = tool_grants.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tool_grant_owners AS owner
        LEFT JOIN tool_grant_owner_authorities AS authority
          ON authority.owner_kind = owner.owner_kind
         AND authority.owner_id = owner.owner_id
         AND authority.owner_generation = owner.owner_generation
        WHERE owner.grant_id = tool_grants.id
          AND (authority.state IS NULL OR authority.state <> 'active')
      )
      AND (expires_at = '' OR expires_at > ?)
      AND (max_uses <= 0 OR use_count < max_uses)
      AND (
        ? = '' OR EXISTS (
          SELECT 1
          FROM tool_grants AS parent
          WHERE parent.id = ?
            AND parent.updated_at = ?
            AND parent.enabled = 1
            AND parent.revoked_at = ''
            AND (parent.expires_at = '' OR parent.expires_at > ?)
            AND EXISTS (
              SELECT 1 FROM tool_grant_owners AS parent_owner
              WHERE parent_owner.grant_id = parent.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM tool_grant_owners AS parent_owner
              LEFT JOIN tool_grant_owner_authorities AS parent_authority
                ON parent_authority.owner_kind = parent_owner.owner_kind
               AND parent_authority.owner_id = parent_owner.owner_id
               AND parent_authority.owner_generation = parent_owner.owner_generation
              WHERE parent_owner.grant_id = parent.id
                AND (parent_authority.state IS NULL OR parent_authority.state <> 'active')
            )
        )
      )
  `);
}
