#compdef cj
_cj() {
  local -a commands
  commands=(
    'chat:Start an interactive multi-turn chat session'
    'config:Configure profiles and local security settings'
    'doctor:Validate configuration and provider access'
    'history:Inspect redacted audit history'
    'memory:Manage explicit local memory'
    'tools:Inspect built-in and local Tools'
    'version:Show version diagnostics'
  )
  _arguments '*:command:->command' && return
  if [[ $state == command ]]; then _describe -t commands command commands; fi
}
_cj "$@"
