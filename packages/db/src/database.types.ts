export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_shares: {
        Row: {
          archive_bytes: number
          archive_path: string
          created_at: string
          created_by: string | null
          engine_commit: string | null
          id: string
          include_database: boolean
          include_files: boolean
          include_memories: boolean
          install_count: number
          preview: Json
          revoked_at: string | null
          source_agent_id: string | null
          source_agent_name: string
          token: string
          workspace_id: number
        }
        Insert: {
          archive_bytes: number
          archive_path: string
          created_at?: string
          created_by?: string | null
          engine_commit?: string | null
          id?: string
          include_database?: boolean
          include_files?: boolean
          include_memories?: boolean
          install_count?: number
          preview: Json
          revoked_at?: string | null
          source_agent_id?: string | null
          source_agent_name: string
          token: string
          workspace_id: number
        }
        Update: {
          archive_bytes?: number
          archive_path?: string
          created_at?: string
          created_by?: string | null
          engine_commit?: string | null
          id?: string
          include_database?: boolean
          include_files?: boolean
          include_memories?: boolean
          install_count?: number
          preview?: Json
          revoked_at?: string | null
          source_agent_id?: string | null
          source_agent_name?: string
          token?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_shares_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_shares_source_agent_id_fkey"
            columns: ["source_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_shares_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          col: number
          created_at: string
          description: string | null
          disabled_at: string | null
          disabled_reason: string | null
          disabled_schedule_slugs: string[]
          engine_agent_id: string | null
          handle: string | null
          id: string
          name: string
          row: number
          space_id: string
          status: Database["public"]["Enums"]["agent_status"]
          template_id: string | null
          workspace_id: number
        }
        Insert: {
          col?: number
          created_at?: string
          description?: string | null
          disabled_at?: string | null
          disabled_reason?: string | null
          disabled_schedule_slugs?: string[]
          engine_agent_id?: string | null
          handle?: string | null
          id?: string
          name: string
          row?: number
          space_id: string
          status?: Database["public"]["Enums"]["agent_status"]
          template_id?: string | null
          workspace_id: number
        }
        Update: {
          col?: number
          created_at?: string
          description?: string | null
          disabled_at?: string | null
          disabled_reason?: string | null
          disabled_schedule_slugs?: string[]
          engine_agent_id?: string | null
          handle?: string | null
          id?: string
          name?: string
          row?: number
          space_id?: string
          status?: Database["public"]["Enums"]["agent_status"]
          template_id?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "agents_space_id_fkey"
            columns: ["space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "agents_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          bound_agent_id: string | null
          created_at: string
          created_by: string | null
          created_by_user_id: string | null
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scope: string
          workspace_id: number
        }
        Insert: {
          bound_agent_id?: string | null
          created_at?: string
          created_by?: string | null
          created_by_user_id?: string | null
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scope?: string
          workspace_id: number
        }
        Update: {
          bound_agent_id?: string | null
          created_at?: string
          created_by?: string | null
          created_by_user_id?: string | null
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scope?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_bound_agent_id_fkey"
            columns: ["bound_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      app_connection_agents: {
        Row: {
          agent_id: string
          app_slug: string
          connection_id: string
          created_at: string
          trigger_slug: string | null
          trigger_token: string | null
          updated_at: string
          wake_on_events: string[]
        }
        Insert: {
          agent_id: string
          app_slug: string
          connection_id: string
          created_at?: string
          trigger_slug?: string | null
          trigger_token?: string | null
          updated_at?: string
          wake_on_events?: string[]
        }
        Update: {
          agent_id?: string
          app_slug?: string
          connection_id?: string
          created_at?: string
          trigger_slug?: string | null
          trigger_token?: string | null
          updated_at?: string
          wake_on_events?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "app_connection_agents_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_connection_agents_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "app_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      app_connections: {
        Row: {
          app_slug: string
          connected_by: string | null
          created_at: string
          id: string
          label: string | null
          last_event_at: string | null
          pause_reason: string | null
          paused_until: string | null
          provider_account_id: string | null
          provider_member_id: string | null
          provider_webhook_id: string | null
          provider_webhook_secret: string | null
          status: string
          updated_at: string
          workspace_id: number
        }
        Insert: {
          app_slug: string
          connected_by?: string | null
          created_at?: string
          id?: string
          label?: string | null
          last_event_at?: string | null
          pause_reason?: string | null
          paused_until?: string | null
          provider_account_id?: string | null
          provider_member_id?: string | null
          provider_webhook_id?: string | null
          provider_webhook_secret?: string | null
          status?: string
          updated_at?: string
          workspace_id: number
        }
        Update: {
          app_slug?: string
          connected_by?: string | null
          created_at?: string
          id?: string
          label?: string | null
          last_event_at?: string | null
          pause_reason?: string | null
          paused_until?: string | null
          provider_account_id?: string | null
          provider_member_id?: string | null
          provider_webhook_id?: string | null
          provider_webhook_secret?: string | null
          status?: string
          updated_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "app_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      app_trial_claims: {
        Row: {
          app_slug: string
          claimed_at: string
          id: string
          provider_member_id: string
          workspace_id: number
        }
        Insert: {
          app_slug: string
          claimed_at?: string
          id?: string
          provider_member_id: string
          workspace_id: number
        }
        Update: {
          app_slug?: string
          claimed_at?: string
          id?: string
          provider_member_id?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "app_trial_claims_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      app_usage_counters: {
        Row: {
          action: string
          count: number
          period: string
          scope: string
          updated_at: string
        }
        Insert: {
          action: string
          count?: number
          period: string
          scope: string
          updated_at?: string
        }
        Update: {
          action?: string
          count?: number
          period?: string
          scope?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_webhook_events: {
        Row: {
          app_slug: string
          event_id: string
          processed_at: string | null
          received_at: string
        }
        Insert: {
          app_slug: string
          event_id: string
          processed_at?: string | null
          received_at?: string
        }
        Update: {
          app_slug?: string
          event_id?: string
          processed_at?: string | null
          received_at?: string
        }
        Relationships: []
      }
      blocked_email_domains: {
        Row: {
          created_at: string
          created_by: string | null
          domain: string
          note: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          domain: string
          note?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          domain?: string
          note?: string | null
        }
        Relationships: []
      }
      blog_posts: {
        Row: {
          author_avatar: string | null
          author_name: string | null
          body_mdx: string
          category: string
          cover_url: string | null
          created_at: string
          excerpt: string | null
          faq: Json
          featured: boolean
          id: string
          meta_description: string | null
          meta_title: string | null
          published: boolean
          published_at: string | null
          related_slugs: string[]
          slug: string
          title: string
          updated_at: string
        }
        Insert: {
          author_avatar?: string | null
          author_name?: string | null
          body_mdx: string
          category: string
          cover_url?: string | null
          created_at?: string
          excerpt?: string | null
          faq?: Json
          featured?: boolean
          id?: string
          meta_description?: string | null
          meta_title?: string | null
          published?: boolean
          published_at?: string | null
          related_slugs?: string[]
          slug: string
          title: string
          updated_at?: string
        }
        Update: {
          author_avatar?: string | null
          author_name?: string | null
          body_mdx?: string
          category?: string
          cover_url?: string | null
          created_at?: string
          excerpt?: string | null
          faq?: Json
          featured?: boolean
          id?: string
          meta_description?: string | null
          meta_title?: string | null
          published?: boolean
          published_at?: string | null
          related_slugs?: string[]
          slug?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      changelog_entries: {
        Row: {
          body_md: string
          created_at: string
          dialog_image_dark_url: string | null
          dialog_image_url: string | null
          id: string
          image_alt: string | null
          image_dark_url: string | null
          image_url: string | null
          published_at: string | null
          slug: string
          title: string
          updated_at: string
        }
        Insert: {
          body_md: string
          created_at?: string
          dialog_image_dark_url?: string | null
          dialog_image_url?: string | null
          id?: string
          image_alt?: string | null
          image_dark_url?: string | null
          image_url?: string | null
          published_at?: string | null
          slug: string
          title: string
          updated_at?: string
        }
        Update: {
          body_md?: string
          created_at?: string
          dialog_image_dark_url?: string | null
          dialog_image_url?: string | null
          id?: string
          image_alt?: string | null
          image_dark_url?: string | null
          image_url?: string | null
          published_at?: string | null
          slug?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      connector_requests: {
        Row: {
          agent_id: string | null
          created_at: string
          description: string
          id: string
          workspace_id: number | null
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          description: string
          id?: string
          workspace_id?: number | null
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          description?: string
          id?: string
          workspace_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "connector_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      creator_accounts: {
        Row: {
          charges_enabled: boolean
          country: string | null
          created_at: string
          default_currency: string | null
          details_submitted: boolean
          disabled_reason: string | null
          onboarded_at: string | null
          payouts_enabled: boolean
          requirements_due: string[]
          stripe_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          charges_enabled?: boolean
          country?: string | null
          created_at?: string
          default_currency?: string | null
          details_submitted?: boolean
          disabled_reason?: string | null
          onboarded_at?: string | null
          payouts_enabled?: boolean
          requirements_due?: string[]
          stripe_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          charges_enabled?: boolean
          country?: string | null
          created_at?: string
          default_currency?: string | null
          details_submitted?: boolean
          disabled_reason?: string | null
          onboarded_at?: string | null
          payouts_enabled?: boolean
          requirements_due?: string[]
          stripe_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "creator_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      device_tokens: {
        Row: {
          app_version: string | null
          created_at: string
          id: string
          last_seen_at: string
          platform: string
          revoked_at: string | null
          token: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          id?: string
          last_seen_at?: string
          platform: string
          revoked_at?: string | null
          token: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          created_at?: string
          id?: string
          last_seen_at?: string
          platform?: string
          revoked_at?: string | null
          token?: string
          user_id?: string
        }
        Relationships: []
      }
      email_sign_up_limits: {
        Row: {
          scope: string
          sign_up_count: number
          window_started_at: string
        }
        Insert: {
          scope: string
          sign_up_count?: number
          window_started_at?: string
        }
        Update: {
          scope?: string
          sign_up_count?: number
          window_started_at?: string
        }
        Relationships: []
      }
      engine_box_metrics: {
        Row: {
          active_runs: number | null
          box_name: string
          cpu_cores: number | null
          engine_ok: boolean
          host_id: string
          rss_mb: number | null
          running: boolean
          sampled_at: string
        }
        Insert: {
          active_runs?: number | null
          box_name: string
          cpu_cores?: number | null
          engine_ok: boolean
          host_id: string
          rss_mb?: number | null
          running: boolean
          sampled_at: string
        }
        Update: {
          active_runs?: number | null
          box_name?: string
          cpu_cores?: number | null
          engine_ok?: boolean
          host_id?: string
          rss_mb?: number | null
          running?: boolean
          sampled_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "engine_box_metrics_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "engine_hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_host_metrics: {
        Row: {
          active_runs: number
          arc_mb: number | null
          boxes_running: number
          boxes_total: number
          cores: number
          cpu_pct: number | null
          disk_total_gb: number | null
          disk_used_gb: number | null
          host_id: string
          load1: number
          load15: number
          load5: number
          mem_available_mb: number
          mem_total_mb: number
          net_rx_bps: number | null
          net_tx_bps: number | null
          psi_cpu: number | null
          psi_io: number | null
          psi_mem: number | null
          sampled_at: string
          swap_total_mb: number
          swap_used_mb: number
        }
        Insert: {
          active_runs: number
          arc_mb?: number | null
          boxes_running: number
          boxes_total: number
          cores: number
          cpu_pct?: number | null
          disk_total_gb?: number | null
          disk_used_gb?: number | null
          host_id: string
          load1: number
          load15: number
          load5: number
          mem_available_mb: number
          mem_total_mb: number
          net_rx_bps?: number | null
          net_tx_bps?: number | null
          psi_cpu?: number | null
          psi_io?: number | null
          psi_mem?: number | null
          sampled_at: string
          swap_total_mb: number
          swap_used_mb: number
        }
        Update: {
          active_runs?: number
          arc_mb?: number | null
          boxes_running?: number
          boxes_total?: number
          cores?: number
          cpu_pct?: number | null
          disk_total_gb?: number | null
          disk_used_gb?: number | null
          host_id?: string
          load1?: number
          load15?: number
          load5?: number
          mem_available_mb?: number
          mem_total_mb?: number
          net_rx_bps?: number | null
          net_tx_bps?: number | null
          psi_cpu?: number | null
          psi_io?: number | null
          psi_mem?: number | null
          sampled_at?: string
          swap_total_mb?: number
          swap_used_mb?: number
        }
        Relationships: [
          {
            foreignKeyName: "engine_host_metrics_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "engine_hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_hosts: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          max_boxes: number
          name: string
          notes: string | null
          public_ip: string
          ssh_user: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          max_boxes?: number
          name: string
          notes?: string | null
          public_ip: string
          ssh_user?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          max_boxes?: number
          name?: string
          notes?: string | null
          public_ip?: string
          ssh_user?: string
          updated_at?: string
        }
        Relationships: []
      }
      engine_pairing_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          token_hash: string
          used_at: string | null
          workspace_id: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          token_hash: string
          used_at?: string | null
          workspace_id: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          token_hash?: string
          used_at?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "engine_pairing_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_pool: {
        Row: {
          box_index: number | null
          claimed_by_workspace_id: number | null
          created_at: string
          engine_api_key: string
          engine_host: string | null
          error_message: string | null
          host_id: string | null
          id: string
          last_update_at: string | null
          last_update_log: string | null
          last_update_status:
            | Database["public"]["Enums"]["engine_update_status"]
            | null
          provider: Database["public"]["Enums"]["cloud_provider"]
          provider_server_id: string | null
          region: string | null
          server_type: string | null
          status: Database["public"]["Enums"]["engine_pool_status"]
          updated_at: string
        }
        Insert: {
          box_index?: number | null
          claimed_by_workspace_id?: number | null
          created_at?: string
          engine_api_key: string
          engine_host?: string | null
          error_message?: string | null
          host_id?: string | null
          id?: string
          last_update_at?: string | null
          last_update_log?: string | null
          last_update_status?:
            | Database["public"]["Enums"]["engine_update_status"]
            | null
          provider?: Database["public"]["Enums"]["cloud_provider"]
          provider_server_id?: string | null
          region?: string | null
          server_type?: string | null
          status?: Database["public"]["Enums"]["engine_pool_status"]
          updated_at?: string
        }
        Update: {
          box_index?: number | null
          claimed_by_workspace_id?: number | null
          created_at?: string
          engine_api_key?: string
          engine_host?: string | null
          error_message?: string | null
          host_id?: string | null
          id?: string
          last_update_at?: string | null
          last_update_log?: string | null
          last_update_status?:
            | Database["public"]["Enums"]["engine_update_status"]
            | null
          provider?: Database["public"]["Enums"]["cloud_provider"]
          provider_server_id?: string | null
          region?: string | null
          server_type?: string | null
          status?: Database["public"]["Enums"]["engine_pool_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "engine_pool_claimed_by_workspace_id_fkey"
            columns: ["claimed_by_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engine_pool_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "engine_hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      expert_email_opt_outs: {
        Row: {
          created_at: string
          email: string
          expert_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          expert_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          expert_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expert_email_opt_outs_expert_id_fkey"
            columns: ["expert_id"]
            isOneToOne: false
            referencedRelation: "experts"
            referencedColumns: ["id"]
          },
        ]
      }
      expert_hire_requests: {
        Row: {
          company_url: string | null
          created_at: string
          email: string
          expert_id: string
          id: string
          message: string
          name: string
        }
        Insert: {
          company_url?: string | null
          created_at?: string
          email: string
          expert_id: string
          id?: string
          message: string
          name: string
        }
        Update: {
          company_url?: string | null
          created_at?: string
          email?: string
          expert_id?: string
          id?: string
          message?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "expert_hire_requests_expert_id_fkey"
            columns: ["expert_id"]
            isOneToOne: false
            referencedRelation: "experts"
            referencedColumns: ["id"]
          },
        ]
      }
      experts: {
        Row: {
          accepted_at: string | null
          application_note: string | null
          application_reviewed_at: string | null
          application_reviewed_by: string | null
          application_status:
            | Database["public"]["Enums"]["expert_application_status"]
            | null
          availability: Database["public"]["Enums"]["expert_availability"]
          avatar_url: string | null
          banner_url: string
          bio: string | null
          budget: string | null
          claim_token: string
          created_at: string
          creator_joined_at: string | null
          creator_terms_accepted_at: string | null
          creator_token: string | null
          email: string | null
          featured: boolean
          github_url: string | null
          id: string
          invite_run_id: string | null
          invite_scheduled_at: string | null
          invited_at: string | null
          languages: string[]
          linkedin_url: string | null
          location: string | null
          name: string
          seo_indexed: boolean
          skills: string[]
          slug: string
          source: Database["public"]["Enums"]["expert_source"]
          status: Database["public"]["Enums"]["expert_status"]
          timezone: string | null
          type: Database["public"]["Enums"]["expert_type"]
          updated_at: string
          website_url: string | null
          x_url: string | null
        }
        Insert: {
          accepted_at?: string | null
          application_note?: string | null
          application_reviewed_at?: string | null
          application_reviewed_by?: string | null
          application_status?:
            | Database["public"]["Enums"]["expert_application_status"]
            | null
          availability?: Database["public"]["Enums"]["expert_availability"]
          avatar_url?: string | null
          banner_url: string
          bio?: string | null
          budget?: string | null
          claim_token?: string
          created_at?: string
          creator_joined_at?: string | null
          creator_terms_accepted_at?: string | null
          creator_token?: string | null
          email?: string | null
          featured?: boolean
          github_url?: string | null
          id?: string
          invite_run_id?: string | null
          invite_scheduled_at?: string | null
          invited_at?: string | null
          languages?: string[]
          linkedin_url?: string | null
          location?: string | null
          name: string
          seo_indexed?: boolean
          skills?: string[]
          slug: string
          source?: Database["public"]["Enums"]["expert_source"]
          status?: Database["public"]["Enums"]["expert_status"]
          timezone?: string | null
          type: Database["public"]["Enums"]["expert_type"]
          updated_at?: string
          website_url?: string | null
          x_url?: string | null
        }
        Update: {
          accepted_at?: string | null
          application_note?: string | null
          application_reviewed_at?: string | null
          application_reviewed_by?: string | null
          application_status?:
            | Database["public"]["Enums"]["expert_application_status"]
            | null
          availability?: Database["public"]["Enums"]["expert_availability"]
          avatar_url?: string | null
          banner_url?: string
          bio?: string | null
          budget?: string | null
          claim_token?: string
          created_at?: string
          creator_joined_at?: string | null
          creator_terms_accepted_at?: string | null
          creator_token?: string | null
          email?: string | null
          featured?: boolean
          github_url?: string | null
          id?: string
          invite_run_id?: string | null
          invite_scheduled_at?: string | null
          invited_at?: string | null
          languages?: string[]
          linkedin_url?: string | null
          location?: string | null
          name?: string
          seo_indexed?: boolean
          skills?: string[]
          slug?: string
          source?: Database["public"]["Enums"]["expert_source"]
          status?: Database["public"]["Enums"]["expert_status"]
          timezone?: string | null
          type?: Database["public"]["Enums"]["expert_type"]
          updated_at?: string
          website_url?: string | null
          x_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "experts_application_reviewed_by_fkey"
            columns: ["application_reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      foreman_conversations: {
        Row: {
          backend: string
          created_at: string
          engine_session_id: string | null
          id: string
          messages: Json
          title: string | null
          updated_at: string
          user_id: string
          workspace_id: number
        }
        Insert: {
          backend?: string
          created_at?: string
          engine_session_id?: string | null
          id?: string
          messages?: Json
          title?: string | null
          updated_at?: string
          user_id: string
          workspace_id: number
        }
        Update: {
          backend?: string
          created_at?: string
          engine_session_id?: string | null
          id?: string
          messages?: Json
          title?: string | null
          updated_at?: string
          user_id?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "foreman_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "foreman_conversations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      foreman_builds: {
        Row: {
          finished_at: string | null
          result: Json | null
          started_at: string
          workspace_id: number
        }
        Insert: {
          finished_at?: string | null
          result?: Json | null
          started_at?: string
          workspace_id: number
        }
        Update: {
          finished_at?: string | null
          result?: Json | null
          started_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "foreman_builds_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      invitation_codes: {
        Row: {
          active: boolean
          code: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          max_uses: number | null
          note: string | null
          plan: string
          uses: number
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          note?: string | null
          plan: string
          uses?: number
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          note?: string | null
          plan?: string
          uses?: number
        }
        Relationships: []
      }
      invitation_redemptions: {
        Row: {
          code_id: string
          id: string
          redeemed_at: string
          user_id: string | null
          workspace_id: number
        }
        Insert: {
          code_id: string
          id?: string
          redeemed_at?: string
          user_id?: string | null
          workspace_id: number
        }
        Update: {
          code_id?: string
          id?: string
          redeemed_at?: string
          user_id?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "invitation_redemptions_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "invitation_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitation_redemptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lifecycle_emails: {
        Row: {
          agent_id: string | null
          id: string
          metadata: Json | null
          sent_at: string
          sequence_key: string
          status: Database["public"]["Enums"]["lifecycle_email_status"]
          user_id: string
          workspace_id: number
        }
        Insert: {
          agent_id?: string | null
          id?: string
          metadata?: Json | null
          sent_at?: string
          sequence_key: string
          status?: Database["public"]["Enums"]["lifecycle_email_status"]
          user_id: string
          workspace_id: number
        }
        Update: {
          agent_id?: string | null
          id?: string
          metadata?: Json | null
          sent_at?: string
          sequence_key?: string
          status?: Database["public"]["Enums"]["lifecycle_email_status"]
          user_id?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "lifecycle_emails_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lifecycle_emails_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lifecycle_emails_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      message_feedback: {
        Row: {
          agent_id: string | null
          category: string | null
          created_at: string
          details: string | null
          foreman_conversation_id: string | null
          id: string
          message_id: string
          message_text: string
          rating: string
          session_id: string | null
          transcript: Json
          updated_at: string
          user_id: string | null
          workspace_id: number
        }
        Insert: {
          agent_id?: string | null
          category?: string | null
          created_at?: string
          details?: string | null
          foreman_conversation_id?: string | null
          id?: string
          message_id: string
          message_text: string
          rating: string
          session_id?: string | null
          transcript?: Json
          updated_at?: string
          user_id?: string | null
          workspace_id: number
        }
        Update: {
          agent_id?: string | null
          category?: string | null
          created_at?: string
          details?: string | null
          foreman_conversation_id?: string | null
          id?: string
          message_id?: string
          message_text?: string
          rating?: string
          session_id?: string | null
          transcript?: Json
          updated_at?: string
          user_id?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "message_feedback_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_feedback_foreman_conversation_id_fkey"
            columns: ["foreman_conversation_id"]
            isOneToOne: false
            referencedRelation: "foreman_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_feedback_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_feedback_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      newsletter_recipients: {
        Row: {
          created_at: string
          email: string
          email_id: string | null
          error: string | null
          id: string
          send_id: string
          sent_at: string | null
          status: Database["public"]["Enums"]["newsletter_recipient_status"]
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          email_id?: string | null
          error?: string | null
          id?: string
          send_id: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["newsletter_recipient_status"]
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          email_id?: string | null
          error?: string | null
          id?: string
          send_id?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["newsletter_recipient_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "newsletter_recipients_send_id_fkey"
            columns: ["send_id"]
            isOneToOne: false
            referencedRelation: "newsletter_sends"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "newsletter_recipients_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      newsletter_sends: {
        Row: {
          audience_size: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          failed_count: number
          id: string
          run_id: string | null
          sent_count: number
          skipped_count: number
          slug: string
          started_at: string | null
          status: Database["public"]["Enums"]["newsletter_send_status"]
          subject: string
        }
        Insert: {
          audience_size?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          failed_count?: number
          id?: string
          run_id?: string | null
          sent_count?: number
          skipped_count?: number
          slug: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["newsletter_send_status"]
          subject: string
        }
        Update: {
          audience_size?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          failed_count?: number
          id?: string
          run_id?: string | null
          sent_count?: number
          skipped_count?: number
          slug?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["newsletter_send_status"]
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "newsletter_sends_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_email_dispatches: {
        Row: {
          created_at: string
          digested_at: string | null
          id: string
          kind: Database["public"]["Enums"]["notification_kind"]
          notification_id: string
          source_key: string
          status: Database["public"]["Enums"]["notification_email_status"]
          user_id: string
          workspace_id: number
        }
        Insert: {
          created_at?: string
          digested_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["notification_kind"]
          notification_id: string
          source_key: string
          status: Database["public"]["Enums"]["notification_email_status"]
          user_id: string
          workspace_id: number
        }
        Update: {
          created_at?: string
          digested_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["notification_kind"]
          notification_id?: string
          source_key?: string
          status?: Database["public"]["Enums"]["notification_email_status"]
          user_id?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "notification_email_dispatches_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_email_dispatches_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_email_dispatches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_email_suppressions: {
        Row: {
          id: string
          last_event_at: string
          released_at: string | null
          source_key: string
          suppressed_at: string
          user_id: string
        }
        Insert: {
          id?: string
          last_event_at?: string
          released_at?: string | null
          source_key: string
          suppressed_at?: string
          user_id: string
        }
        Update: {
          id?: string
          last_event_at?: string
          released_at?: string | null
          source_key?: string
          suppressed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_email_suppressions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_incidents: {
        Row: {
          opened_at: string
          resolved_at: string | null
          source_key: string
          user_id: string
        }
        Insert: {
          opened_at?: string
          resolved_at?: string | null
          source_key: string
          user_id: string
        }
        Update: {
          opened_at?: string
          resolved_at?: string | null
          source_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_incidents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_push_dispatches: {
        Row: {
          created_at: string
          id: string
          source_key: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          source_key: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          source_key?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          agent_id: string | null
          created_at: string
          engine_agent_id: string | null
          engine_run_id: string | null
          engine_session_id: string | null
          event: string
          id: string
          kind: Database["public"]["Enums"]["notification_kind"]
          message: string
          metadata: Json | null
          notified_at: string
          read_at: string | null
          recipients: Json | null
          source: Database["public"]["Enums"]["session_source"] | null
          space_id: string | null
          workspace_id: number
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          engine_agent_id?: string | null
          engine_run_id?: string | null
          engine_session_id?: string | null
          event?: string
          id?: string
          kind?: Database["public"]["Enums"]["notification_kind"]
          message: string
          metadata?: Json | null
          notified_at?: string
          read_at?: string | null
          recipients?: Json | null
          source?: Database["public"]["Enums"]["session_source"] | null
          space_id?: string | null
          workspace_id: number
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          engine_agent_id?: string | null
          engine_run_id?: string | null
          engine_session_id?: string | null
          event?: string
          id?: string
          kind?: Database["public"]["Enums"]["notification_kind"]
          message?: string
          metadata?: Json | null
          notified_at?: string
          read_at?: string | null
          recipients?: Json | null
          source?: Database["public"]["Enums"]["session_source"] | null
          space_id?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "notifications_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_space_id_fkey"
            columns: ["space_id"]
            isOneToOne: false
            referencedRelation: "spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_pending_grants: {
        Row: {
          agent_id: string
          created_at: string
          expires_at: string
          jti: string
          kind: string | null
          payload: Json | null
          user_id: string
          workspace_id: number
        }
        Insert: {
          agent_id: string
          created_at?: string
          expires_at: string
          jti: string
          kind?: string | null
          payload?: Json | null
          user_id: string
          workspace_id: number
        }
        Update: {
          agent_id?: string
          created_at?: string
          expires_at?: string
          jti?: string
          kind?: string | null
          payload?: Json | null
          user_id?: string
          workspace_id?: number
        }
        Relationships: []
      }
      paid_data_events: {
        Row: {
          billed_micros: number
          capability: string
          created_at: string
          duration_ms: number | null
          engine_agent_id: string | null
          id: number
          outcome: string
          provider_cost_micros: number
          served_by: string | null
          tool: string
          treg_call_id: string | null
          treg_status: number | null
          workspace_id: number
        }
        Insert: {
          billed_micros?: number
          capability: string
          created_at?: string
          duration_ms?: number | null
          engine_agent_id?: string | null
          id?: never
          outcome: string
          provider_cost_micros?: number
          served_by?: string | null
          tool: string
          treg_call_id?: string | null
          treg_status?: number | null
          workspace_id: number
        }
        Update: {
          billed_micros?: number
          capability?: string
          created_at?: string
          duration_ms?: number | null
          engine_agent_id?: string | null
          id?: never
          outcome?: string
          provider_cost_micros?: number
          served_by?: string | null
          tool?: string
          treg_call_id?: string | null
          treg_status?: number | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "paid_data_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_sign_in_send_limits: {
        Row: {
          scope: string
          send_count: number
          window_started_at: string
        }
        Insert: {
          scope: string
          send_count?: number
          window_started_at?: string
        }
        Update: {
          scope?: string
          send_count?: number
          window_started_at?: string
        }
        Relationships: []
      }
      phone_sign_in_sends: {
        Row: {
          last_channel: string | null
          last_sent_at: string | null
          phone: string
          send_count: number
          send_window_started_at: string | null
        }
        Insert: {
          last_channel?: string | null
          last_sent_at?: string | null
          phone: string
          send_count?: number
          send_window_started_at?: string | null
        }
        Update: {
          last_channel?: string | null
          last_sent_at?: string | null
          phone?: string
          send_count?: number
          send_window_started_at?: string | null
        }
        Relationships: []
      }
      published_access_codes: {
        Row: {
          attempts: number
          code_hash: string
          created_at: string
          email: string
          expires_at: string
          id: string
          published_file_id: string
        }
        Insert: {
          attempts?: number
          code_hash: string
          created_at?: string
          email: string
          expires_at: string
          id?: string
          published_file_id: string
        }
        Update: {
          attempts?: number
          code_hash?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          published_file_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "published_access_codes_published_file_id_fkey"
            columns: ["published_file_id"]
            isOneToOne: false
            referencedRelation: "published_files"
            referencedColumns: ["id"]
          },
        ]
      }
      published_files: {
        Row: {
          access: string
          access_version: number
          agent_id: string
          content_type: string
          created_at: string
          files: string[] | null
          id: string
          invited: string[]
          kind: string
          password_hash: string | null
          public_url: string
          requested_access: string | null
          size: number
          slug: string
          source_path: string
          space_id: string | null
          storage_key: string
          thumbnail_key: string | null
          title: string | null
          updated_at: string
          workspace_id: number
        }
        Insert: {
          access?: string
          access_version?: number
          agent_id: string
          content_type?: string
          created_at?: string
          files?: string[] | null
          id?: string
          invited?: string[]
          kind?: string
          password_hash?: string | null
          public_url: string
          requested_access?: string | null
          size?: number
          slug: string
          source_path: string
          space_id?: string | null
          storage_key: string
          thumbnail_key?: string | null
          title?: string | null
          updated_at?: string
          workspace_id: number
        }
        Update: {
          access?: string
          access_version?: number
          agent_id?: string
          content_type?: string
          created_at?: string
          files?: string[] | null
          id?: string
          invited?: string[]
          kind?: string
          password_hash?: string | null
          public_url?: string
          requested_access?: string | null
          size?: number
          slug?: string
          source_path?: string
          space_id?: string | null
          storage_key?: string
          thumbnail_key?: string | null
          title?: string | null
          updated_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "published_files_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "published_files_space_id_fkey"
            columns: ["space_id"]
            isOneToOne: false
            referencedRelation: "spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "published_files_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      published_gate_attempts: {
        Row: {
          attempt_count: number
          scope: string
          window_started_at: string
        }
        Insert: {
          attempt_count?: number
          scope: string
          window_started_at?: string
        }
        Update: {
          attempt_count?: number
          scope?: string
          window_started_at?: string
        }
        Relationships: []
      }
      rerun_usage_events: {
        Row: {
          billed: boolean
          cost_micros: number
          created_at: string
          engine_agent_id: string | null
          id: string
          input_tokens: number
          model: string
          output_tokens: number
          space_id: string | null
          tier: string | null
          workspace_id: number
        }
        Insert: {
          billed?: boolean
          cost_micros?: number
          created_at?: string
          engine_agent_id?: string | null
          id?: string
          input_tokens?: number
          model: string
          output_tokens?: number
          space_id?: string | null
          tier?: string | null
          workspace_id: number
        }
        Update: {
          billed?: boolean
          cost_micros?: number
          created_at?: string
          engine_agent_id?: string | null
          id?: string
          input_tokens?: number
          model?: string
          output_tokens?: number
          space_id?: string | null
          tier?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "rerun_usage_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      service_alternatives: {
        Row: {
          alternative_slug: string
          confidence: number
          created_at: string
          model: string
          probability: number
          service_slug: string
        }
        Insert: {
          alternative_slug: string
          confidence: number
          created_at?: string
          model: string
          probability: number
          service_slug: string
        }
        Update: {
          alternative_slug?: string
          confidence?: number
          created_at?: string
          model?: string
          probability?: number
          service_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_alternatives_alternative_slug_fkey"
            columns: ["alternative_slug"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "service_alternatives_service_slug_fkey"
            columns: ["service_slug"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["slug"]
          },
        ]
      }
      services: {
        Row: {
          category: string
          created_at: string
          embedding: string | null
          enabled: boolean
          icon: string | null
          manifest: Json
          name: string
          slug: string
          summary: string
          updated_at: string
          verified: boolean
        }
        Insert: {
          category?: string
          created_at?: string
          embedding?: string | null
          enabled?: boolean
          icon?: string | null
          manifest: Json
          name: string
          slug: string
          summary?: string
          updated_at?: string
          verified?: boolean
        }
        Update: {
          category?: string
          created_at?: string
          embedding?: string | null
          enabled?: boolean
          icon?: string | null
          manifest?: Json
          name?: string
          slug?: string
          summary?: string
          updated_at?: string
          verified?: boolean
        }
        Relationships: []
      }
      session_participants: {
        Row: {
          last_message_at: string
          session_id: string
          user_id: string
        }
        Insert: {
          last_message_at?: string
          session_id: string
          user_id: string
        }
        Update: {
          last_message_at?: string
          session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_participants_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      session_reads: {
        Row: {
          seen_at: string
          session_id: string
          user_id: string
        }
        Insert: {
          seen_at?: string
          session_id: string
          user_id: string
        }
        Update: {
          seen_at?: string
          session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_reads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_reads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          agent_id: string
          automation_name: string | null
          created_at: string
          engine_session_id: string
          first_message: string | null
          id: string
          kind: Database["public"]["Enums"]["session_kind"]
          origin_agent_id: string | null
          outcome: Database["public"]["Enums"]["session_outcome"] | null
          source: Database["public"]["Enums"]["session_source"]
          status: Database["public"]["Enums"]["session_status"]
          title: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          automation_name?: string | null
          created_at?: string
          engine_session_id: string
          first_message?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["session_kind"]
          origin_agent_id?: string | null
          outcome?: Database["public"]["Enums"]["session_outcome"] | null
          source?: Database["public"]["Enums"]["session_source"]
          status?: Database["public"]["Enums"]["session_status"]
          title?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          automation_name?: string | null
          created_at?: string
          engine_session_id?: string
          first_message?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["session_kind"]
          origin_agent_id?: string | null
          outcome?: Database["public"]["Enums"]["session_outcome"] | null
          source?: Database["public"]["Enums"]["session_source"]
          status?: Database["public"]["Enums"]["session_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_origin_agent_id_fkey"
            columns: ["origin_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      sign_in_codes: {
        Row: {
          code: string
          email: string
          expires_at: string
          issued_at: string
          last_sent_at: string
          send_count: number
          token_hash: string
          type: string
          user_id: string
        }
        Insert: {
          code: string
          email: string
          expires_at: string
          issued_at?: string
          last_sent_at?: string
          send_count?: number
          token_hash: string
          type: string
          user_id: string
        }
        Update: {
          code?: string
          email?: string
          expires_at?: string
          issued_at?: string
          last_sent_at?: string
          send_count?: number
          token_hash?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      slack_channel_agents: {
        Row: {
          agent_id: string
          channel_id: string
          channel_name: string | null
          connection_id: string
          created_at: string
          display_name: string | null
          icon_emoji: string | null
          icon_url: string | null
          id: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          channel_id: string
          channel_name?: string | null
          connection_id: string
          created_at?: string
          display_name?: string | null
          icon_emoji?: string | null
          icon_url?: string | null
          id?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          channel_id?: string
          channel_name?: string | null
          connection_id?: string
          created_at?: string
          display_name?: string | null
          icon_emoji?: string | null
          icon_url?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slack_channel_agents_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_channel_agents_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "slack_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_connections: {
        Row: {
          bot_token: string
          bot_user_id: string | null
          can_customize_identity: boolean
          connected_by: string | null
          created_at: string
          id: string
          last_event_at: string | null
          last_signature_error_at: string | null
          signing_secret: string
          status: string
          team_id: string
          team_name: string | null
          updated_at: string
          workspace_id: number
        }
        Insert: {
          bot_token: string
          bot_user_id?: string | null
          can_customize_identity?: boolean
          connected_by?: string | null
          created_at?: string
          id?: string
          last_event_at?: string | null
          last_signature_error_at?: string | null
          signing_secret: string
          status?: string
          team_id: string
          team_name?: string | null
          updated_at?: string
          workspace_id: number
        }
        Update: {
          bot_token?: string
          bot_user_id?: string | null
          can_customize_identity?: boolean
          connected_by?: string | null
          created_at?: string
          id?: string
          last_event_at?: string | null
          last_signature_error_at?: string | null
          signing_secret?: string
          status?: string
          team_id?: string
          team_name?: string | null
          updated_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "slack_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_events: {
        Row: {
          event_id: string
          processed_at: string | null
          received_at: string
          team_id: string | null
        }
        Insert: {
          event_id: string
          processed_at?: string | null
          received_at?: string
          team_id?: string | null
        }
        Update: {
          event_id?: string
          processed_at?: string | null
          received_at?: string
          team_id?: string | null
        }
        Relationships: []
      }
      slack_threads: {
        Row: {
          agent_id: string
          channel_id: string
          connection_id: string
          created_at: string
          engine_session_id: string | null
          session_id: string | null
          thread_ts: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          channel_id: string
          connection_id: string
          created_at?: string
          engine_session_id?: string | null
          session_id?: string | null
          thread_ts: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          channel_id?: string
          connection_id?: string
          created_at?: string
          engine_session_id?: string | null
          session_id?: string | null
          thread_ts?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slack_threads_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_threads_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "slack_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_threads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      space_members: {
        Row: {
          access: string
          created_at: string
          granted_by: string | null
          space_id: string
          user_id: string
          workspace_id: number
        }
        Insert: {
          access: string
          created_at?: string
          granted_by?: string | null
          space_id: string
          user_id: string
          workspace_id: number
        }
        Update: {
          access?: string
          created_at?: string
          granted_by?: string | null
          space_id?: string
          user_id?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "space_members_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "space_members_space_id_workspace_id_fkey"
            columns: ["space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "space_members_user_id_workspace_id_fkey"
            columns: ["user_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["user_id", "workspace_id"]
          },
        ]
      }
      spaces: {
        Row: {
          col_end: number
          col_start: number
          created_at: string | null
          id: string
          name: string | null
          row_end: number
          row_start: number
          visibility: string
          workspace_id: number
        }
        Insert: {
          col_end: number
          col_start: number
          created_at?: string | null
          id?: string
          name?: string | null
          row_end: number
          row_start: number
          visibility?: string
          workspace_id: number
        }
        Update: {
          col_end?: number
          col_start?: number
          created_at?: string | null
          id?: string
          name?: string | null
          row_end?: number
          row_start?: number
          visibility?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "spaces_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          claimed_at: string
          connected_account_id: string | null
          id: string
          processed_at: string | null
          type: string
        }
        Insert: {
          claimed_at?: string
          connected_account_id?: string | null
          id: string
          processed_at?: string | null
          type: string
        }
        Update: {
          claimed_at?: string
          connected_account_id?: string | null
          id?: string
          processed_at?: string | null
          type?: string
        }
        Relationships: []
      }
      template_purchases: {
        Row: {
          activated_at: string | null
          amount_cents: number
          cancel_at_period_end: boolean
          created_at: string
          creator_id: string | null
          currency: string
          current_period_end: string | null
          id: string
          pricing_model: Database["public"]["Enums"]["template_pricing_model"]
          purchased_by: string | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["template_purchase_status"]
          stripe_checkout_session_id: string | null
          stripe_connected_account_id: string | null
          stripe_payment_intent_id: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          template_id: string
          updated_at: string
          workspace_id: number
        }
        Insert: {
          activated_at?: string | null
          amount_cents?: number
          cancel_at_period_end?: boolean
          created_at?: string
          creator_id?: string | null
          currency?: string
          current_period_end?: string | null
          id?: string
          pricing_model: Database["public"]["Enums"]["template_pricing_model"]
          purchased_by?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["template_purchase_status"]
          stripe_checkout_session_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          template_id: string
          updated_at?: string
          workspace_id: number
        }
        Update: {
          activated_at?: string | null
          amount_cents?: number
          cancel_at_period_end?: boolean
          created_at?: string
          creator_id?: string | null
          currency?: string
          current_period_end?: string | null
          id?: string
          pricing_model?: Database["public"]["Enums"]["template_pricing_model"]
          purchased_by?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["template_purchase_status"]
          stripe_checkout_session_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          template_id?: string
          updated_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "template_purchases_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_purchases_purchased_by_fkey"
            columns: ["purchased_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_purchases_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_purchases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      template_sales: {
        Row: {
          application_fee_cents: number
          created_at: string
          creator_id: string | null
          currency: string
          gross_cents: number
          id: string
          kind: string
          net_cents: number
          occurred_at: string
          purchase_id: string | null
          stripe_charge_id: string | null
          stripe_connected_account_id: string | null
          stripe_invoice_id: string | null
          stripe_transfer_id: string | null
          tax_cents: number
          template_id: string | null
          template_slug: string
          template_title: string
          workspace_id: number | null
        }
        Insert: {
          application_fee_cents?: number
          created_at?: string
          creator_id?: string | null
          currency?: string
          gross_cents: number
          id?: string
          kind: string
          net_cents: number
          occurred_at?: string
          purchase_id?: string | null
          stripe_charge_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_invoice_id?: string | null
          stripe_transfer_id?: string | null
          tax_cents?: number
          template_id?: string | null
          template_slug: string
          template_title: string
          workspace_id?: number | null
        }
        Update: {
          application_fee_cents?: number
          created_at?: string
          creator_id?: string | null
          currency?: string
          gross_cents?: number
          id?: string
          kind?: string
          net_cents?: number
          occurred_at?: string
          purchase_id?: string | null
          stripe_charge_id?: string | null
          stripe_connected_account_id?: string | null
          stripe_invoice_id?: string | null
          stripe_transfer_id?: string | null
          tax_cents?: number
          template_id?: string | null
          template_slug?: string
          template_title?: string
          workspace_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "template_sales_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_sales_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "template_purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_sales_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_sales_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          agent_archives: Json
          agent_count: number | null
          agents: Json
          card_image_dark_url: string | null
          card_image_light_url: string | null
          category: string
          connectors: Json
          created_at: string
          creator_id: string | null
          faq: Json
          featured: boolean
          gallery: Json
          id: string
          lead_magnet: boolean
          long_description: string
          meta_description: string | null
          meta_title: string | null
          og_image_url: string | null
          price_amount_cents: number
          price_currency: string
          price_synced_at: string | null
          pricing_model: Database["public"]["Enums"]["template_pricing_model"]
          published_at: string | null
          review_note: string | null
          role_page: Json
          setup_minutes: number
          show_in_library: boolean
          show_in_marketplace: boolean
          slug: string
          status: Database["public"]["Enums"]["template_status"]
          story: Json
          stripe_price_id: string | null
          stripe_product_id: string | null
          submitted_at: string | null
          tagline: string
          tags: string[]
          title: string
          updated_at: string
          video_url: string | null
        }
        Insert: {
          agent_archives?: Json
          agent_count?: number | null
          agents?: Json
          card_image_dark_url?: string | null
          card_image_light_url?: string | null
          category?: string
          connectors?: Json
          created_at?: string
          creator_id?: string | null
          faq?: Json
          featured?: boolean
          gallery?: Json
          id?: string
          lead_magnet?: boolean
          long_description?: string
          meta_description?: string | null
          meta_title?: string | null
          og_image_url?: string | null
          price_amount_cents?: number
          price_currency?: string
          price_synced_at?: string | null
          pricing_model?: Database["public"]["Enums"]["template_pricing_model"]
          published_at?: string | null
          review_note?: string | null
          role_page?: Json
          setup_minutes?: number
          show_in_library?: boolean
          show_in_marketplace?: boolean
          slug: string
          status?: Database["public"]["Enums"]["template_status"]
          story?: Json
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          submitted_at?: string | null
          tagline?: string
          tags?: string[]
          title: string
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          agent_archives?: Json
          agent_count?: number | null
          agents?: Json
          card_image_dark_url?: string | null
          card_image_light_url?: string | null
          category?: string
          connectors?: Json
          created_at?: string
          creator_id?: string | null
          faq?: Json
          featured?: boolean
          gallery?: Json
          id?: string
          lead_magnet?: boolean
          long_description?: string
          meta_description?: string | null
          meta_title?: string | null
          og_image_url?: string | null
          price_amount_cents?: number
          price_currency?: string
          price_synced_at?: string | null
          pricing_model?: Database["public"]["Enums"]["template_pricing_model"]
          published_at?: string | null
          review_note?: string | null
          role_page?: Json
          setup_minutes?: number
          show_in_library?: boolean
          show_in_marketplace?: boolean
          slug?: string
          status?: Database["public"]["Enums"]["template_status"]
          story?: Json
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          submitted_at?: string | null
          tagline?: string
          tags?: string[]
          title?: string
          updated_at?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "templates_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trial_card_fingerprints: {
        Row: {
          created_at: string
          fingerprint: string
          id: string
          payment_method_id: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          trial_skipped_at: string | null
          workspace_id: number | null
        }
        Insert: {
          created_at?: string
          fingerprint: string
          id?: string
          payment_method_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_skipped_at?: string | null
          workspace_id?: number | null
        }
        Update: {
          created_at?: string
          fingerprint?: string
          id?: string
          payment_method_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_skipped_at?: string | null
          workspace_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trial_card_fingerprints_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_phones: {
        Row: {
          channel: string | null
          contact_consent_at: string | null
          last_sent_at: string | null
          phone: string | null
          required_at: string
          send_count: number
          send_window_started_at: string | null
          skipped_at: string | null
          unverifiable_at: string | null
          user_id: string
          verified_at: string | null
          whatsapp_opted_out_at: string | null
          whatsapp_replied_at: string | null
          whatsapp_unreachable_at: string | null
        }
        Insert: {
          channel?: string | null
          contact_consent_at?: string | null
          last_sent_at?: string | null
          phone?: string | null
          required_at?: string
          send_count?: number
          send_window_started_at?: string | null
          skipped_at?: string | null
          unverifiable_at?: string | null
          user_id: string
          verified_at?: string | null
          whatsapp_opted_out_at?: string | null
          whatsapp_replied_at?: string | null
          whatsapp_unreachable_at?: string | null
        }
        Update: {
          channel?: string | null
          contact_consent_at?: string | null
          last_sent_at?: string | null
          phone?: string | null
          required_at?: string
          send_count?: number
          send_window_started_at?: string | null
          skipped_at?: string | null
          unverifiable_at?: string | null
          user_id?: string
          verified_at?: string | null
          whatsapp_opted_out_at?: string | null
          whatsapp_replied_at?: string | null
          whatsapp_unreachable_at?: string | null
        }
        Relationships: []
      }
      user_presence: {
        Row: {
          last_seen_at: string
          user_id: string
        }
        Insert: {
          last_seen_at?: string
          user_id: string
        }
        Update: {
          last_seen_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_presence_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          account_role: Database["public"]["Enums"]["account_role"]
          changelog_seen_at: string
          created_at: string
          deleted_at: string | null
          email_notification_prefs: Json
          expert_profile_id: string | null
          id: string
          onboarding_answers: Json | null
          onboarding_completed_at: string | null
          signed_up_at: string | null
          verified: boolean
          workspace_id: number
        }
        Insert: {
          account_role?: Database["public"]["Enums"]["account_role"]
          changelog_seen_at?: string
          created_at?: string
          deleted_at?: string | null
          email_notification_prefs?: Json
          expert_profile_id?: string | null
          id: string
          onboarding_answers?: Json | null
          onboarding_completed_at?: string | null
          signed_up_at?: string | null
          verified?: boolean
          workspace_id: number
        }
        Update: {
          account_role?: Database["public"]["Enums"]["account_role"]
          changelog_seen_at?: string
          created_at?: string
          deleted_at?: string | null
          email_notification_prefs?: Json
          expert_profile_id?: string | null
          id?: string
          onboarding_answers?: Json | null
          onboarding_completed_at?: string | null
          signed_up_at?: string | null
          verified?: boolean
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "users_expert_profile_id_fkey"
            columns: ["expert_profile_id"]
            isOneToOne: false
            referencedRelation: "experts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      web_fetch_events: {
        Row: {
          content_chars: number
          created_at: string
          direct_status: number | null
          duration_ms: number | null
          engine_agent_id: string | null
          host: string | null
          id: number
          outcome: string
          page_status: number | null
          provider_status: number | null
          url: string
          workspace_id: number
        }
        Insert: {
          content_chars?: number
          created_at?: string
          direct_status?: number | null
          duration_ms?: number | null
          engine_agent_id?: string | null
          host?: string | null
          id?: never
          outcome: string
          page_status?: number | null
          provider_status?: number | null
          url: string
          workspace_id: number
        }
        Update: {
          content_chars?: number
          created_at?: string
          direct_status?: number | null
          duration_ms?: number | null
          engine_agent_id?: string | null
          host?: string | null
          id?: never
          outcome?: string
          page_status?: number | null
          provider_status?: number | null
          url?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "web_fetch_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      web_search_cache: {
        Row: {
          fetched_at: string
          query_key: string
          results: Json
        }
        Insert: {
          fetched_at?: string
          query_key: string
          results: Json
        }
        Update: {
          fetched_at?: string
          query_key?: string
          results?: Json
        }
        Relationships: []
      }
      web_search_events: {
        Row: {
          cached: boolean
          created_at: string
          duration_ms: number | null
          engine_agent_id: string | null
          id: number
          outcome: string
          provider_status: number | null
          query: string
          result_count: number
          workspace_id: number
        }
        Insert: {
          cached?: boolean
          created_at?: string
          duration_ms?: number | null
          engine_agent_id?: string | null
          id?: never
          outcome: string
          provider_status?: number | null
          query: string
          result_count?: number
          workspace_id: number
        }
        Update: {
          cached?: boolean
          created_at?: string
          duration_ms?: number | null
          engine_agent_id?: string | null
          id?: never
          outcome?: string
          provider_status?: number | null
          query?: string
          result_count?: number
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "web_search_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          agent_id: string | null
          bird_message_id: string | null
          category: string
          created_at: string
          dedupe_key: string | null
          delivered_at: string | null
          error: string | null
          error_code: string | null
          failed_at: string | null
          id: string
          language: string
          meta_error_code: string | null
          phone: string
          read_at: string | null
          sent_at: string | null
          status: string
          template_key: string
          user_id: string
          workspace_id: number | null
        }
        Insert: {
          agent_id?: string | null
          bird_message_id?: string | null
          category: string
          created_at?: string
          dedupe_key?: string | null
          delivered_at?: string | null
          error?: string | null
          error_code?: string | null
          failed_at?: string | null
          id?: string
          language: string
          meta_error_code?: string | null
          phone: string
          read_at?: string | null
          sent_at?: string | null
          status?: string
          template_key: string
          user_id: string
          workspace_id?: number | null
        }
        Update: {
          agent_id?: string | null
          bird_message_id?: string | null
          category?: string
          created_at?: string
          dedupe_key?: string | null
          delivered_at?: string | null
          error?: string | null
          error_code?: string | null
          failed_at?: string | null
          id?: string
          language?: string
          meta_error_code?: string | null
          phone?: string
          read_at?: string | null
          sent_at?: string | null
          status?: string
          template_key?: string
          user_id?: string
          workspace_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_archives: {
        Row: {
          archived_at: string | null
          bytes: number | null
          created_at: string
          data_version: number | null
          engine_commit: string | null
          error_message: string | null
          expires_at: string | null
          id: string
          object_key: string
          raw_bytes: number | null
          reactivation_approved_at: string | null
          reactivation_rejected_at: string | null
          reactivation_request_note: string | null
          reactivation_requested_at: string | null
          reactivation_reviewed_by: string | null
          reason: Database["public"]["Enums"]["workspace_archive_reason"]
          restored_at: string | null
          restored_to_instance_id: string | null
          sha256: string | null
          source_box: string
          source_host_id: string | null
          source_host_name: string
          status: Database["public"]["Enums"]["workspace_archive_status"]
          workspace_id: number
        }
        Insert: {
          archived_at?: string | null
          bytes?: number | null
          created_at?: string
          data_version?: number | null
          engine_commit?: string | null
          error_message?: string | null
          expires_at?: string | null
          id?: string
          object_key: string
          raw_bytes?: number | null
          reactivation_approved_at?: string | null
          reactivation_rejected_at?: string | null
          reactivation_request_note?: string | null
          reactivation_requested_at?: string | null
          reactivation_reviewed_by?: string | null
          reason?: Database["public"]["Enums"]["workspace_archive_reason"]
          restored_at?: string | null
          restored_to_instance_id?: string | null
          sha256?: string | null
          source_box: string
          source_host_id?: string | null
          source_host_name: string
          status?: Database["public"]["Enums"]["workspace_archive_status"]
          workspace_id: number
        }
        Update: {
          archived_at?: string | null
          bytes?: number | null
          created_at?: string
          data_version?: number | null
          engine_commit?: string | null
          error_message?: string | null
          expires_at?: string | null
          id?: string
          object_key?: string
          raw_bytes?: number | null
          reactivation_approved_at?: string | null
          reactivation_rejected_at?: string | null
          reactivation_request_note?: string | null
          reactivation_requested_at?: string | null
          reactivation_reviewed_by?: string | null
          reason?: Database["public"]["Enums"]["workspace_archive_reason"]
          restored_at?: string | null
          restored_to_instance_id?: string | null
          sha256?: string | null
          source_box?: string
          source_host_id?: string | null
          source_host_name?: string
          status?: Database["public"]["Enums"]["workspace_archive_status"]
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_archives_reactivation_reviewed_by_fkey"
            columns: ["reactivation_reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_archives_restored_to_instance_id_fkey"
            columns: ["restored_to_instance_id"]
            isOneToOne: false
            referencedRelation: "engine_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_archives_source_host_id_fkey"
            columns: ["source_host_id"]
            isOneToOne: false
            referencedRelation: "engine_hosts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_archives_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_getting_started: {
        Row: {
          done_at: string
          item: string
          reported_at: string | null
          workspace_id: number
        }
        Insert: {
          done_at?: string
          item: string
          reported_at?: string | null
          workspace_id: number
        }
        Update: {
          done_at?: string
          item?: string
          reported_at?: string | null
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_getting_started_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitations: {
        Row: {
          accepted_at: string | null
          box_scope: string
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          status: string
          token: string
          workspace_id: number
        }
        Insert: {
          accepted_at?: string | null
          box_scope?: string
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          status?: string
          token: string
          workspace_id: number
        }
        Update: {
          accepted_at?: string | null
          box_scope?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          status?: string
          token?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          box_scope: string
          created_at: string
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: number
        }
        Insert: {
          box_scope?: string
          created_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: number
        }
        Update: {
          box_scope?: string
          created_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_onboarding: {
        Row: {
          agent_ideas: Json | null
          answers: Json
          company_findings: Json | null
          updated_at: string
          workspace_id: number
        }
        Insert: {
          agent_ideas?: Json | null
          answers?: Json
          company_findings?: Json | null
          updated_at?: string
          workspace_id: number
        }
        Update: {
          agent_ideas?: Json | null
          answers?: Json
          company_findings?: Json | null
          updated_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_onboarding_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_apps: {
        Row: {
          app_slug: string
          created_at: string
          frozen_at: string | null
          slots: number
          status: string
          trial_settled_at: string | null
          trial_ends_at: string | null
          trial_reminder_sent_at: string | null
          updated_at: string
          workspace_id: number
        }
        Insert: {
          app_slug: string
          created_at?: string
          frozen_at?: string | null
          slots?: number
          status?: string
          trial_settled_at?: string | null
          trial_ends_at?: string | null
          trial_reminder_sent_at?: string | null
          updated_at?: string
          workspace_id: number
        }
        Update: {
          app_slug?: string
          created_at?: string
          frozen_at?: string | null
          slots?: number
          status?: string
          trial_settled_at?: string | null
          trial_ends_at?: string | null
          trial_reminder_sent_at?: string | null
          updated_at?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_apps_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_rewind_views: {
        Row: {
          rewind_id: string
          user_id: string
          viewed_at: string
        }
        Insert: {
          rewind_id: string
          user_id: string
          viewed_at?: string
        }
        Update: {
          rewind_id?: string
          user_id?: string
          viewed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_rewind_views_rewind_id_fkey"
            columns: ["rewind_id"]
            isOneToOne: false
            referencedRelation: "workspace_rewinds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_rewind_views_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_rewinds: {
        Row: {
          created_at: string
          id: string
          payload: Json
          week_start: string
          workspace_id: number
        }
        Insert: {
          created_at?: string
          id?: string
          payload: Json
          week_start: string
          workspace_id: number
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          week_start?: string
          workspace_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "workspace_rewinds_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          boxes_archived_at: string | null
          boxes_deleted_at: string | null
          boxes_disabled_at: string | null
          created_at: string
          current_period_end: string | null
          custom_integrations: boolean
          first_paid_at: string | null
          icon_url: string | null
          id: number
          is_sandbox: boolean
          last_active_at: string | null
          max_agents: number | null
          max_seats: number | null
          model_access: string | null
          name: string | null
          onboarded_at: string | null
          payment_failed_at: string | null
          plan: string
          price_arm: string | null
          publish_policy: string | null
          renewal_reminder_at: string | null
          renewal_reminder_user_id: string | null
          rerun_budget_micros: number
          rerun_credit_paused_at: string | null
          rerun_period_anchor: string | null
          rerun_topup_micros: number
          rerun_used_micros: number
          stripe_customer_id: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          subscription_cancel_at: string | null
          subscription_status: string | null
          trial_ends_at: string | null
          trial_started_at: string | null
          waitlisted_at: string | null
        }
        Insert: {
          boxes_archived_at?: string | null
          boxes_deleted_at?: string | null
          boxes_disabled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          custom_integrations?: boolean
          first_paid_at?: string | null
          icon_url?: string | null
          id?: number
          is_sandbox?: boolean
          last_active_at?: string | null
          max_agents?: number | null
          max_seats?: number | null
          model_access?: string | null
          name?: string | null
          onboarded_at?: string | null
          payment_failed_at?: string | null
          plan?: string
          price_arm?: string | null
          publish_policy?: string | null
          renewal_reminder_at?: string | null
          renewal_reminder_user_id?: string | null
          rerun_budget_micros?: number
          rerun_credit_paused_at?: string | null
          rerun_period_anchor?: string | null
          rerun_topup_micros?: number
          rerun_used_micros?: number
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          subscription_cancel_at?: string | null
          subscription_status?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          waitlisted_at?: string | null
        }
        Update: {
          boxes_archived_at?: string | null
          boxes_deleted_at?: string | null
          boxes_disabled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          custom_integrations?: boolean
          first_paid_at?: string | null
          icon_url?: string | null
          id?: number
          is_sandbox?: boolean
          last_active_at?: string | null
          max_agents?: number | null
          max_seats?: number | null
          model_access?: string | null
          name?: string | null
          onboarded_at?: string | null
          payment_failed_at?: string | null
          plan?: string
          price_arm?: string | null
          publish_policy?: string | null
          renewal_reminder_at?: string | null
          renewal_reminder_user_id?: string | null
          rerun_budget_micros?: number
          rerun_credit_paused_at?: string | null
          rerun_period_anchor?: string | null
          rerun_topup_micros?: number
          rerun_used_micros?: number
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          subscription_cancel_at?: string | null
          subscription_status?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          waitlisted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_renewal_reminder_user_id_fkey"
            columns: ["renewal_reminder_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      anonymize_auth_user: {
        Args: { p_email: string; p_user_id: string }
        Returns: undefined
      }
      before_user_created: { Args: { event: Json }; Returns: Json }
      check_email_exists: { Args: { email: string }; Returns: boolean }
      claim_app_quota: {
        Args: {
          p_action: string
          p_amount?: number
          p_maxes: number[]
          p_periods: string[]
          p_scope: string
        }
        Returns: boolean
      }
      claim_email_sign_up: {
        Args: { p_ip: string; p_ip_max: number; p_window_seconds: number }
        Returns: boolean
      }
      claim_phone_sign_in_send:
        | {
            Args: {
              p_global_max: number
              p_ip: string
              p_ip_max: number
              p_window_seconds: number
            }
            Returns: string
          }
        | {
            Args: {
              p_app: string
              p_app_max: number
              p_global_max: number
              p_ip: string
              p_ip_max: number
              p_window_seconds: number
            }
            Returns: string
          }
      claim_phone_sign_in_verify: {
        Args: {
          p_ip: string
          p_ip_max: number
          p_phone: string
          p_phone_max: number
          p_window_seconds: number
        }
        Returns: string
      }
      claim_published_gate_attempt: {
        Args: { p_max: number; p_scopes: string[]; p_window_seconds: number }
        Returns: boolean
      }
      consume_rerun_credit: {
        Args: { p_micros: number; p_workspace_id: number }
        Returns: undefined
      }
      current_admin_workspace_ids: { Args: never; Returns: number[] }
      current_workspace_ids: { Args: never; Returns: number[] }
      email_domain_is_blocked: { Args: { p_email: string }; Returns: boolean }
      engine_box_metric_series: {
        Args: {
          p_bucket: string
          p_from: string
          p_host_id: string
          p_top: number
        }
        Returns: {
          box_name: string
          points: Json
        }[]
      }
      engine_host_metric_series: {
        Args: { p_bucket: string; p_from: string }
        Returns: {
          host_id: string
          points: Json
        }[]
      }
      grant_rerun_topup: {
        Args: { p_micros: number; p_workspace_id: number }
        Returns: undefined
      }
      manageable_agent_ids: { Args: never; Returns: string[] }
      manageable_space_ids: { Args: never; Returns: string[] }
      mark_getting_started: {
        Args: { p_item: string; p_workspace_id: number }
        Returns: undefined
      }
      match_services: {
        Args: {
          filter_category?: string
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          category: string
          icon: string
          manifest: Json
          name: string
          similarity: number
          slug: string
          summary: string
        }[]
      }
      open_notification_incident: {
        Args: { p_source_key: string; p_user_id: string }
        Returns: boolean
      }
      rerun_credit_usage: {
        Args: {
          p_since: string
          p_workspace_id: number
        }
        Returns: {
          calls: number
          day: string
          engine_agent_id: string
          kind: string
          micros: number
          source: string
        }[]
      }
      resolve_notification_incidents: {
        Args: { p_source_key: string }
        Returns: string[]
      }
      touch_sandbox_activity: { Args: { p_user_id: string }; Returns: undefined }
      unseen_runs: {
        Args: { p_workspace_id: number }
        Returns: {
          agent_id: string
          last_at: string
          message: string
          run_count: number
          session_id: string
          slug: string | null
          source: Database["public"]["Enums"]["session_source"]
          title: string
        }[]
      }
      visible_agent_ids: { Args: never; Returns: string[] }
      visible_space_ids: { Args: never; Returns: string[] }
    }
    Enums: {
      account_role: "member" | "expert"
      agent_service_status: "active" | "needs_config" | "error"
      agent_status: "idle" | "working" | "error" | "waiting_human" | "offline"
      cloud_provider: "incus"
      engine_pool_status:
        | "provisioning"
        | "available"
        | "claimed"
        | "error"
        | "updating"
      engine_update_status: "success" | "error" | "deferred" | "abandoned"
      expert_application_status: "pending" | "accepted" | "rejected"
      expert_availability: "available" | "soon" | "unavailable"
      expert_source: "seed" | "import" | "application"
      expert_status: "draft" | "invited" | "published" | "declined"
      expert_type: "studio" | "freelancer" | "expert"
      lifecycle_email_status: "sent" | "failed"
      newsletter_recipient_status: "pending" | "sent" | "failed" | "skipped"
      newsletter_send_status:
        | "queued"
        | "sending"
        | "sent"
        | "failed"
        | "canceled"
      notification_email_status: "sent" | "suppressed" | "digested" | "skipped"
      notification_kind:
        | "info"
        | "question"
        | "approval"
        | "done"
        | "error"
        | "connector"
      session_kind: "general" | "thread"
      session_outcome: "done" | "nothing" | "failed"
      session_source:
        | "dashboard"
        | "builder"
        | "schedule"
        | "agent"
        | "delegate"
        | "api"
        | "trigger"
      session_status:
        | "idle"
        | "working"
        | "error"
        | "waiting_human"
        | "awaiting_question"
        | "awaiting_approval"
        | "awaiting_connector"
        | "awaiting_ack"
      template_pricing_model: "free" | "one_time" | "recurring"
      template_purchase_status:
        | "pending"
        | "active"
        | "past_due"
        | "canceled"
        | "refunded"
      template_status:
        | "draft"
        | "in_review"
        | "published"
        | "unlisted"
        | "archived"
      workspace_archive_reason: "access_ended" | "inactivity" | "manual"
      workspace_archive_status:
        | "archiving"
        | "archived"
        | "restoring"
        | "restored"
        | "failed"
      workspace_role: "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_role: ["member", "expert"],
      agent_service_status: ["active", "needs_config", "error"],
      agent_status: ["idle", "working", "error", "waiting_human", "offline"],
      cloud_provider: ["incus"],
      engine_pool_status: [
        "provisioning",
        "available",
        "claimed",
        "error",
        "updating",
      ],
      engine_update_status: ["success", "error", "deferred", "abandoned"],
      expert_application_status: ["pending", "accepted", "rejected"],
      expert_availability: ["available", "soon", "unavailable"],
      expert_source: ["seed", "import", "application"],
      expert_status: ["draft", "invited", "published", "declined"],
      expert_type: ["studio", "freelancer", "expert"],
      lifecycle_email_status: ["sent", "failed"],
      newsletter_recipient_status: ["pending", "sent", "failed", "skipped"],
      newsletter_send_status: [
        "queued",
        "sending",
        "sent",
        "failed",
        "canceled",
      ],
      notification_email_status: ["sent", "suppressed", "digested", "skipped"],
      notification_kind: [
        "info",
        "question",
        "approval",
        "done",
        "error",
        "connector",
      ],
      session_kind: ["general", "thread"],
      session_outcome: ["done", "nothing", "failed"],
      session_source: [
        "dashboard",
        "builder",
        "schedule",
        "agent",
        "delegate",
        "api",
        "trigger",
      ],
      session_status: [
        "idle",
        "working",
        "error",
        "waiting_human",
        "awaiting_question",
        "awaiting_approval",
        "awaiting_connector",
        "awaiting_ack",
      ],
      template_pricing_model: ["free", "one_time", "recurring"],
      template_purchase_status: [
        "pending",
        "active",
        "past_due",
        "canceled",
        "refunded",
      ],
      template_status: [
        "draft",
        "in_review",
        "published",
        "unlisted",
        "archived",
      ],
      workspace_archive_reason: ["access_ended", "inactivity", "manual"],
      workspace_archive_status: [
        "archiving",
        "archived",
        "restoring",
        "restored",
        "failed",
      ],
      workspace_role: ["admin", "member"],
    },
  },
} as const
