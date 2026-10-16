// Runs when Jenkins starts: turns security off (local sandbox only) and creates the pipeline
// job `demo-extension` from the Jenkinsfile in the image.
import hudson.security.AuthorizationStrategy
import hudson.security.SecurityRealm
import jenkins.model.Jenkins
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import org.jenkinsci.plugins.workflow.job.WorkflowJob

def jenkins = Jenkins.get()
jenkins.setSecurityRealm(SecurityRealm.NO_AUTHENTICATION)
jenkins.setAuthorizationStrategy(new AuthorizationStrategy.Unsecured())
jenkins.setNumExecutors(2)
jenkins.save()

if (jenkins.getItem('demo-extension') == null) {
  def job = jenkins.createProject(WorkflowJob, 'demo-extension')
  def script = new File('/var/jenkins_home/leuchtturm/Jenkinsfile').text
  job.setDefinition(new CpsFlowDefinition(script, true))
  job.setDescription('Builds the next version of the Leuchtturm demo extension. Click "Build Now".')
  job.save()
}
