Register-ArgumentCompleter -Native -CommandName cj -ScriptBlock {
  param($wordToComplete)
  @('chat','config','doctor','history','memory','tools','version','--json','--verbose','--dry-run','--task-events','--profile') |
    Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
