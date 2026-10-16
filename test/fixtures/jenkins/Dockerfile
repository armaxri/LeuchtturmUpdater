# A real Jenkins for `npm run full-sandbox` and `npm run test:jenkins`. Build context:
# test/fixtures (so the demo extension's code is shared with the other demos).
#
# Local sandbox only: no setup wizard, no login (Leuchtturm handles no credentials; the
# container is published on 127.0.0.1 only).
FROM jenkins/jenkins:lts-jdk21

ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"

# Basic Pipeline support (scripted pipelines), downloaded once from the Jenkins update center when the image is built.
COPY jenkins/plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

# Security off, one pipeline job (see the script).
COPY jenkins/init.groovy.d/ /usr/share/jenkins/ref/init.groovy.d/
COPY jenkins/Jenkinsfile /usr/share/jenkins/ref/leuchtturm/Jenkinsfile

# What the pipeline packages: the demo extension, with __VERSION__ placeholders.
COPY jenkins/demo/ /opt/leuchtturm-demo/
COPY demo-extension/extension.js /opt/leuchtturm-demo/extension.js
