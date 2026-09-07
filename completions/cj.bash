_cj() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local commands="chat config doctor history memory tools version"
  local globals="--json --verbose --language --timeout --plain --no-color --dry-run --task-events --profile --help --version"
  COMPREPLY=( $(compgen -W "${commands} ${globals}" -- "${cur}") )
}
complete -F _cj cj
